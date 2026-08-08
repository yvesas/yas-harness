# `src/http/` — talking to an HTTP endpoint

## Boundary

Not a client, and not a transport. The harness has no HTTP surface of its own
(ADRs 0007–0009) and every adapter writes its own `fetch` calls. What lives here
is the handful of things more than one of them has to get right, and that are
easy to get wrong in the same way twice.

## `trimTrailingSlashes`

Because the obvious version is a security finding. `/\/+$/` takes polynomial
time on a long run of slashes, and a base URL comes from configuration or an
environment variable — close enough to input to matter.

CodeQL caught it in the OTLP exporter, and then caught the identical pattern in
the embedding adapter. One file, one function, no third time.
