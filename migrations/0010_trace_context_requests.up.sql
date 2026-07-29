-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- A module asking another for context is a step of a turn like any other, so it
-- goes in the same trace rather than a table of its own. It is also the step
-- most worth being able to look up afterwards: it is the only point where data
-- crosses a module boundary, and the record of who asked, for what, and what
-- the owner answered is the audit trail for that crossing.

ALTER TABLE traces
    DROP CONSTRAINT traces_kind_check;

ALTER TABLE traces
    ADD CONSTRAINT traces_kind_check CHECK (
        kind IN ('input', 'route', 'model_call', 'tool_call', 'context_request', 'approval', 'reply')
    );
