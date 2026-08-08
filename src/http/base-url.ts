// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Handling the base URL of an HTTP endpoint.
 *
 * One function, in its own file, because the obvious way to write it is a
 * security finding and this project has now written it twice. `/\/+$/` takes
 * polynomial time on a long run of slashes, and a base URL arrives from
 * configuration or an environment variable — close enough to input that paying
 * for a scan is not worth saving a line.
 *
 * The first time was the OTLP exporter, caught by CodeQL. The second was the
 * embedding adapter, caught by CodeQL again. There will not be a third.
 */

/** Drop trailing slashes without a pattern that can be made to crawl. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') {
    end -= 1;
  }
  return url.slice(0, end);
}
