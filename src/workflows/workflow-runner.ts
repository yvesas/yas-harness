// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Running a workflow: several agents in order, with places for a person.
 *
 * The shape is the agent's own pause, one level up. A run walks its steps; when
 * something needs a human it writes down where it got to and returns. Nothing
 * blocks, nothing is held in memory, and a deploy in the middle loses only the
 * step in flight. `resume` picks it up by reading, not by remembering.
 *
 * Two different things can pause a run, and telling them apart is most of what
 * this file does:
 *
 *   - the **step gate** (`approve: true`) — a person decides before the step
 *     runs at all. Nothing has been sent to a model; the decision is about
 *     whether it should be.
 *   - the **write gate** — the agent's own `requiresApproval` firing inside the
 *     step. The turn is half done and a tool call is held; resuming continues
 *     *that turn*, in that session, as that module.
 *
 * Each step gets its own session. That is the load-bearing decision here: one
 * agent's tool results never land in another agent's context, so a workflow
 * schedules agents without merging them. What crosses between steps is only
 * what a prompt quotes with `{{steps.<id>}}` — explicit, visible in the config,
 * and reviewable in a diff. Anything else would route around the rule that
 * agents ask each other for things (doc 13, decision 2) by making a workflow
 * the back door.
 */

import type { Agent, AgentReply } from '../core/agent.js';
import type { ApprovalStore } from '../approval/approval-store.js';
import type { SessionStore } from '../memory/session-store.js';

import { render } from './template.js';
import { missingAgents, type WorkflowConfig, type WorkflowStep } from './workflow-config.js';
import { type StepRun, type WorkflowRun, type WorkflowRunStore } from './workflow-run-store.js';

export interface WorkflowRunnerDependencies {
  readonly agent: Agent;
  readonly sessions: SessionStore;
  readonly runs: WorkflowRunStore;
  /** The workflows that can be started, by id. */
  readonly workflows: ReadonlyMap<string, WorkflowConfig>;
  /**
   * Which agents exist. Read at run time rather than captured, because a
   * product registers its modules after the harness is assembled.
   */
  readonly agents: () => ReadonlySet<string>;
  /**
   * Where a step gate waits. Without one, a workflow containing a gated step
   * refuses to start — the same fail-closed rule the agent applies to a gated
   * tool. A gate nobody can answer is not a gate.
   */
  readonly approvals?: ApprovalStore;
  /** The persona new step sessions are created under. */
  readonly personaId: string;
}

export interface StartWorkflowInput {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly input: string;
  readonly startedBy?: string;
}

/** A run and its steps, which is what any caller actually wants back. */
export interface WorkflowRunDetail {
  readonly run: WorkflowRun;
  readonly steps: readonly StepRun[];
}

export class WorkflowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkflowError';
  }
}

export class WorkflowRunner {
  readonly #agent: Agent;
  readonly #sessions: SessionStore;
  readonly #runs: WorkflowRunStore;
  readonly #workflows: ReadonlyMap<string, WorkflowConfig>;
  readonly #agents: () => ReadonlySet<string>;
  readonly #approvals: ApprovalStore | undefined;
  readonly #personaId: string;

  constructor(dependencies: WorkflowRunnerDependencies) {
    this.#agent = dependencies.agent;
    this.#sessions = dependencies.sessions;
    this.#runs = dependencies.runs;
    this.#workflows = dependencies.workflows;
    this.#agents = dependencies.agents;
    this.#approvals = dependencies.approvals;
    this.#personaId = dependencies.personaId;
  }

  /**
   * Begin a run and carry it as far as it goes.
   *
   * Returns when the run finishes, fails, or stops for a person — all three are
   * ordinary outcomes, and the status says which.
   */
  async start(input: StartWorkflowInput): Promise<WorkflowRunDetail> {
    const config = this.#config(input.workflowId);

    // Checked before a row exists: a run recorded and immediately failed for a
    // reason visible in the config is noise in the history, and the person who
    // pressed the button wants the reason, not a failed run to go and read.
    const missing = missingAgents(config, this.#agents());
    if (missing.length > 0) {
      throw new WorkflowError(
        `workflow "${config.id}" names ${missing.length === 1 ? 'an agent' : 'agents'} that ` +
          `${missing.length === 1 ? 'is' : 'are'} not registered: ${missing.join(', ')}`,
      );
    }
    if (!this.#approvals && config.steps.some((step) => step.approve)) {
      throw new WorkflowError(
        `workflow "${config.id}" has a step that waits for a person, and no approval queue is ` +
          `wired. Wire one, or take the gate off the step — a gate nobody can answer is not a gate.`,
      );
    }

    const run = await this.#runs.start({
      tenantId: input.tenantId,
      workflowId: config.id,
      input: input.input,
      ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }),
    });

    return this.#drive(config, run);
  }

  /**
   * Continue a run that was waiting.
   *
   * Safe to call when it was not: a run that is already finished comes back
   * unchanged rather than starting over, because the button that calls this is
   * one somebody can press twice.
   */
  async resume(tenantId: string, runId: string): Promise<WorkflowRunDetail> {
    const run = await this.#runs.find(tenantId, runId);
    if (!run) {
      throw new WorkflowError(`run "${runId}" not found for tenant "${tenantId}"`);
    }
    if (run.status === 'completed' || run.status === 'failed') {
      return { run, steps: await this.#runs.steps(tenantId, runId) };
    }
    return this.#drive(this.#config(run.workflowId), run);
  }

  async detail(tenantId: string, runId: string): Promise<WorkflowRunDetail | null> {
    const run = await this.#runs.find(tenantId, runId);
    return run ? { run, steps: await this.#runs.steps(tenantId, runId) } : null;
  }

  #config(workflowId: string): WorkflowConfig {
    const config = this.#workflows.get(workflowId);
    if (!config) {
      throw new WorkflowError(`no workflow called "${workflowId}"`);
    }
    return config;
  }

  /** Walk the steps from wherever this run got to. */
  async #drive(config: WorkflowConfig, started: WorkflowRun): Promise<WorkflowRunDetail> {
    const { tenantId, id: runId } = started;
    const done = new Map<string, StepRun>();
    for (const step of await this.#runs.steps(tenantId, runId)) {
      done.set(step.stepId, step);
    }

    for (const step of config.steps) {
      const previous = done.get(step.id);
      if (previous?.status === 'completed') {
        continue;
      }

      let outcome: StepOutcome;
      try {
        outcome = await this.#step(started, step, previous, done);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#runs.recordStep({
          tenantId,
          runId,
          stepId: step.id,
          agentId: step.agent,
          prompt: previous?.prompt ?? step.prompt,
          status: 'failed',
          awaiting: null,
          error: message,
        });
        // The run stops here rather than carrying on without the answer this
        // step was supposed to produce. A later step quoting a failed one would
        // otherwise be handed the failure as if it were content.
        const failed = await this.#runs.setStatus(tenantId, runId, 'failed', message);
        return { run: failed, steps: await this.#runs.steps(tenantId, runId) };
      }

      if (outcome.kind === 'waiting') {
        const waiting = await this.#runs.setStatus(tenantId, runId, 'awaiting_approval');
        return { run: waiting, steps: await this.#runs.steps(tenantId, runId) };
      }
      if (outcome.kind === 'rejected') {
        const failed = await this.#runs.setStatus(tenantId, runId, 'failed', outcome.reason);
        return { run: failed, steps: await this.#runs.steps(tenantId, runId) };
      }

      done.set(step.id, outcome.step);
    }

    const completed = await this.#runs.setStatus(tenantId, runId, 'completed');
    return { run: completed, steps: await this.#runs.steps(tenantId, runId) };
  }

  /** One step: gate, then turn, then what came out. */
  async #step(
    run: WorkflowRun,
    step: WorkflowStep,
    previous: StepRun | undefined,
    done: ReadonlyMap<string, StepRun>,
  ): Promise<StepOutcome> {
    const { tenantId, id: runId } = run;

    // Rendered before the gate, so the person deciding sees what would be sent
    // rather than a template. A gate that shows `{{steps.draft}}` is a gate
    // somebody approves without knowing what they approved.
    const prompt = render(step.prompt, this.#values(run, done));

    if (previous?.status === 'awaiting_approval' && previous.awaiting === 'tool') {
      // The agent's own write gate. The turn is half done in its own session,
      // and the module has to be named again or it resumes with the wrong tools.
      const sessionId = previous.sessionId;
      if (sessionId === null) {
        throw new WorkflowError(
          `step "${step.id}" is waiting on a tool call but has no session; its conversation was ` +
            `deleted, so the held call cannot be resumed`,
        );
      }
      const reply = await this.#agent.resume({ tenantId, sessionId, moduleId: step.agent });
      return this.#record(tenantId, runId, step, prompt, sessionId, reply);
    }

    if (step.approve) {
      const decision = await this.#gate(tenantId, runId, step, prompt, previous);
      if (decision.kind !== 'go') {
        return decision;
      }
    }

    // A session per step. Created here rather than reused from a previous
    // attempt, because a rejected-then-approved step should not carry the
    // history of the attempt that was refused.
    const session = await this.#sessions.create({ tenantId, personaId: this.#personaId });
    await this.#runs.recordStep({
      tenantId,
      runId,
      stepId: step.id,
      agentId: step.agent,
      prompt,
      sessionId: session.id,
      status: 'running',
      awaiting: null,
    });

    const reply = await this.#agent.run({
      tenantId,
      sessionId: session.id,
      input: prompt,
      moduleId: step.agent,
    });
    return this.#record(tenantId, runId, step, prompt, session.id, reply);
  }

  /** Ask a person, or read the answer they already gave. */
  async #gate(
    tenantId: string,
    runId: string,
    step: WorkflowStep,
    prompt: string,
    previous: StepRun | undefined,
  ): Promise<GateOutcome> {
    const approvals = this.#approvals;
    if (!approvals) {
      // Unreachable through `start`, which refuses earlier. Kept because the
      // alternative to failing closed here is running an ungated step.
      throw new WorkflowError(`step "${step.id}" waits for a person and no queue is wired`);
    }

    if (previous?.status === 'awaiting_approval' && previous.approvalId) {
      const approval = await approvals.find(tenantId, previous.approvalId);
      if (!approval || approval.status === 'pending') {
        return { kind: 'waiting' };
      }
      if (approval.status === 'rejected') {
        const reason = approval.reason ?? 'a person declined this step';
        await this.#runs.recordStep({
          tenantId,
          runId,
          stepId: step.id,
          agentId: step.agent,
          prompt,
          status: 'skipped',
          awaiting: null,
          approvalId: approval.id,
          error: reason,
        });
        return { kind: 'rejected', reason: `step "${step.id}" was declined: ${reason}` };
      }
      return { kind: 'go' };
    }

    // The workflow's gate goes into the same queue as a gated tool call, on
    // purpose: a person deciding has one inbox, and two would mean one of them
    // goes unwatched. It needs a session to belong to, so the step's own is
    // created before the gate rather than after it.
    const session = await this.#sessions.create({ tenantId, personaId: this.#personaId });
    const [approval] = await approvals.request([
      {
        tenantId,
        sessionId: session.id,
        // The step of the run, which is unique and reads as what it is in an
        // audit trail months later.
        toolCallId: `${runId}:${step.id}`,
        toolName: `workflow.${step.id}`,
        input: { runId, step: step.id, agent: step.agent, prompt },
      },
    ]);

    await this.#runs.recordStep({
      tenantId,
      runId,
      stepId: step.id,
      agentId: step.agent,
      prompt,
      sessionId: session.id,
      status: 'awaiting_approval',
      awaiting: 'step',
      approvalId: approval!.id,
    });
    return { kind: 'waiting' };
  }

  /** Write down what a turn produced, and say whether the run can continue. */
  async #record(
    tenantId: string,
    runId: string,
    step: WorkflowStep,
    prompt: string,
    sessionId: string,
    reply: AgentReply,
  ): Promise<StepOutcome> {
    if (reply.stopReason === 'awaiting_approval') {
      await this.#runs.recordStep({
        tenantId,
        runId,
        stepId: step.id,
        agentId: step.agent,
        prompt,
        sessionId,
        traceId: reply.traceId,
        status: 'awaiting_approval',
        awaiting: 'tool',
      });
      return { kind: 'waiting' };
    }

    const recorded = await this.#runs.recordStep({
      tenantId,
      runId,
      stepId: step.id,
      agentId: step.agent,
      prompt,
      sessionId,
      traceId: reply.traceId,
      output: reply.text,
      status: 'completed',
      awaiting: null,
    });
    return { kind: 'done', step: recorded };
  }

  /** What `{{...}}` can be filled with at this point in the run. */
  #values(run: WorkflowRun, done: ReadonlyMap<string, StepRun>): Record<string, string> {
    const values: Record<string, string> = { input: run.input };
    for (const [stepId, step] of done) {
      if (step.status === 'completed' && step.output !== null) {
        values[`steps.${stepId}`] = step.output;
      }
    }
    return values;
  }
}

type StepOutcome =
  | { readonly kind: 'done'; readonly step: StepRun }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'rejected'; readonly reason: string };

/** A gate's answer: run it, keep waiting, or the person said no. */
type GateOutcome = { readonly kind: 'go' } | Extract<StepOutcome, { kind: 'waiting' | 'rejected' }>;
