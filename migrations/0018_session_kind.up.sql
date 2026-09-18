-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- What a session is *for*, which is not the same as whose voice it speaks in.
--
-- `persona_id` has been the only thing a session said about itself, and it
-- answers a different question: a persona is a voice, and two sessions can
-- share one while meaning entirely different things — a person typing, and a
-- scheduled job nobody is watching.
--
-- The difference matters the moment anything durable comes out of a turn. A
-- person in a conversation is present to be wrong in front of; a cron run at
-- 3am is not, and neither is a sub-agent spawned to answer one question for
-- another agent. Letting those write into shared knowledge means a corpus that
-- grows while nobody is looking, from turns nobody read — and the write path is
-- the security boundary, because a fact recorded by a job reads exactly like a
-- fact somebody approved.
--
-- So the kind is recorded here rather than inferred later. Inferring it is what
-- we would be reduced to otherwise, and there is nothing to infer it *from*:
-- a session row looks identical whichever created it.
--
-- `interactive` is the default because it is the only kind that can be
-- established by the absence of anything else — something created a session
-- without saying why, and the conservative reading of that is a person. The
-- gated kinds all have a caller that knows it is one.

ALTER TABLE sessions
    ADD COLUMN kind text NOT NULL DEFAULT 'interactive';

ALTER TABLE sessions
    ADD CONSTRAINT sessions_kind_check
        CHECK (kind IN ('interactive', 'workflow', 'scheduled', 'subagent'));

COMMENT ON COLUMN sessions.kind IS
    'What the session is for. Gates durable side effects: scheduled and subagent turns produce no memory candidate.';
