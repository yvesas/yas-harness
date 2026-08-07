// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

import { MoonIcon, SunIcon } from '@phosphor-icons/react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // The server does not know which theme the browser resolved, so rendering the
  // icon before mounting would guess — and be wrong half the time, visibly.
  useEffect(() => {
    setMounted(true);
  }, []);

  const dark = resolvedTheme === 'dark';

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={dark ? 'Switch to light' : 'Switch to dark'}
      onClick={() => {
        setTheme(dark ? 'light' : 'dark');
      }}
    >
      {mounted ? (
        dark ? (
          <SunIcon weight="bold" />
        ) : (
          <MoonIcon weight="bold" />
        )
      ) : (
        <span className="size-4" />
      )}
    </Button>
  );
}
