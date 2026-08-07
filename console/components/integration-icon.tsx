// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector's logo, when there is one.
 *
 * A lookup rather than a lot of conditionals, and a plug for whatever is not on
 * it — a source the harness has never heard of should look unremarkable, not
 * broken. The keys are connector ids, which are the deployment's to choose, so
 * a miss is expected rather than exceptional.
 */

import {
  GithubLogo,
  GoogleDriveLogo,
  GoogleLogo,
  MicrosoftTeamsLogo,
  NotionLogo,
  Plug,
  SlackLogo,
} from '@phosphor-icons/react/dist/ssr';

type PhosphorIcon = typeof Plug;

const LOGOS: Record<string, PhosphorIcon> = {
  github: GithubLogo,
  'google-drive': GoogleDriveLogo,
  'google-calendar': GoogleLogo,
  slack: SlackLogo,
  notion: NotionLogo,
  teams: MicrosoftTeamsLogo,
};

export function IntegrationIcon({
  connectorId,
  className,
}: {
  connectorId: string;
  className?: string;
}) {
  const Logo = LOGOS[connectorId] ?? Plug;
  return <Logo className={className} weight="fill" />;
}
