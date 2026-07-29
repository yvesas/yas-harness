-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Rolling back narrows the allowed kinds again, so any context_request step
-- already recorded has to go first: leaving it would make the constraint
-- unsatisfiable and the migration fail half way.

DELETE FROM traces WHERE kind = 'context_request';

ALTER TABLE traces
    DROP CONSTRAINT traces_kind_check;

ALTER TABLE traces
    ADD CONSTRAINT traces_kind_check CHECK (
        kind IN ('input', 'route', 'model_call', 'tool_call', 'approval', 'reply')
    );
