// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * Light and dark, remembered.
 *
 * `next-themes` rather than a `useState`, for one reason worth the dependency:
 * it writes the class before the first paint. Doing it in an effect means the
 * page renders light, then flips — the flash everybody has seen and nobody
 * wants on a console they keep open all day.
 *
 * The default is the system's. A tool that ignores what the machine already
 * decided is a tool with an opinion nobody asked for.
 */

import { ThemeProvider as NextThemes } from 'next-themes';
import type { ReactNode } from 'react';

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemes attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemes>
  );
}
