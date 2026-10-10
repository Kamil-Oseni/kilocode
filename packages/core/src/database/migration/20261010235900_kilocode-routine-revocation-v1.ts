// kilocode_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261010235900_kilocode-routine-revocation-v1",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_insert
        AFTER INSERT ON session
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.id)))
            ) OR (session IN (NEW.id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_update
        AFTER UPDATE ON session
        WHEN (OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.directory IS NOT NEW.directory OR OLD.path IS NOT NEW.path OR OLD.metadata IS NOT NEW.metadata OR OLD.revert IS NOT NEW.revert OR OLD.permission IS NOT NEW.permission OR OLD.agent IS NOT NEW.agent OR OLD.model IS NOT NEW.model OR OLD.time_archived IS NOT NEW.time_archived) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.id, NEW.id)))
            ) OR (session IN (OLD.id, NEW.id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.id, NEW.id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_delete
        BEFORE DELETE ON session
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.id)))
            ) OR (session IN (OLD.id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_message_insert
        AFTER INSERT ON message
        WHEN (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN json_extract(NEW.data, '$.role') IS NOT 'assistant' ELSE 1 END)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_message_update
        AFTER UPDATE ON message
        WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.data IS NOT NEW.data OR OLD.time_created IS NOT NEW.time_created) AND ((CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) THEN json_extract(OLD.data, '$.role') IS NOT 'assistant' ELSE 1 END OR CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN json_extract(NEW.data, '$.role') IS NOT 'assistant' ELSE 1 END) OR OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.time_created IS NOT NEW.time_created OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.parentID') IS NOT json_extract(NEW.data, '$.parentID') OR json_extract(OLD.data, '$.agent') IS NOT json_extract(NEW.data, '$.agent') OR json_extract(OLD.data, '$.mode') IS NOT json_extract(NEW.data, '$.mode') OR json_extract(OLD.data, '$.modelID') IS NOT json_extract(NEW.data, '$.modelID') OR json_extract(OLD.data, '$.providerID') IS NOT json_extract(NEW.data, '$.providerID') OR json_extract(OLD.data, '$.model') IS NOT json_extract(NEW.data, '$.model') OR json_extract(OLD.data, '$.variant') IS NOT json_extract(NEW.data, '$.variant') OR json_extract(OLD.data, '$.path') IS NOT json_extract(NEW.data, '$.path') OR json_extract(OLD.data, '$.request') IS NOT json_extract(NEW.data, '$.request') OR json_extract(OLD.data, '$.metadata') IS NOT json_extract(NEW.data, '$.metadata') OR json_extract(OLD.data, '$.time.created') IS NOT json_extract(NEW.data, '$.time.created')) ELSE 1 END OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_message_delete
        BEFORE DELETE ON message
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_part_insert
        AFTER INSERT ON part
        WHEN ((NOT (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) OR NOT EXISTS (SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id AND CASE WHEN (CASE WHEN length(CAST(message.data AS BLOB)) <= 2097152 THEN json_valid(message.data) ELSE 0 END) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END)))
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_part_update
        AFTER UPDATE ON part
        WHEN (OLD.id IS NOT NEW.id OR OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.data IS NOT NEW.data OR OLD.time_created IS NOT NEW.time_created) AND (((NOT (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) OR NOT EXISTS (SELECT 1 FROM message WHERE id = OLD.message_id AND session_id = OLD.session_id AND CASE WHEN (CASE WHEN length(CAST(message.data AS BLOB)) <= 2097152 THEN json_valid(message.data) ELSE 0 END) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END)) OR (NOT (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) OR NOT EXISTS (SELECT 1 FROM message WHERE id = NEW.message_id AND session_id = NEW.session_id AND CASE WHEN (CASE WHEN length(CAST(message.data AS BLOB)) <= 2097152 THEN json_valid(message.data) ELSE 0 END) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END))) OR OLD.id IS NOT NEW.id OR OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.time_created IS NOT NEW.time_created OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.type') IS NOT json_extract(NEW.data, '$.type') OR json_extract(OLD.data, '$.tool') IS NOT json_extract(NEW.data, '$.tool') OR json_extract(OLD.data, '$.callID') IS NOT json_extract(NEW.data, '$.callID') OR json_extract(OLD.data, '$.state.input') IS NOT json_extract(NEW.data, '$.state.input') OR json_extract(OLD.data, '$.state.time.start') IS NOT json_extract(NEW.data, '$.state.time.start')) ELSE 1 END OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.state.status') IN ('completed', 'error') AND (json_extract(OLD.data, '$.state') IS NOT json_extract(NEW.data, '$.state'))) ELSE 1 END OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_part_delete
        BEFORE DELETE ON part
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_message_insert
        AFTER INSERT ON session_message
        WHEN ((NOT (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_type(NEW.data, '$.content') IS NULL OR (json_type(NEW.data, '$.content') = 'array' AND json_array_length(NEW.data, '$.content') <= 1024)) ELSE 0 END) OR NEW.type NOT IN ('assistant', 'tool', 'text', 'reasoning')))
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_message_update
        AFTER UPDATE ON session_message
        WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.type IS NOT NEW.type OR OLD.seq IS NOT NEW.seq OR OLD.data IS NOT NEW.data OR OLD.time_created IS NOT NEW.time_created) AND (((NOT (CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) THEN (json_type(OLD.data, '$.content') IS NULL OR (json_type(OLD.data, '$.content') = 'array' AND json_array_length(OLD.data, '$.content') <= 1024)) ELSE 0 END) OR OLD.type NOT IN ('assistant', 'tool', 'text', 'reasoning')) OR (NOT (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_type(NEW.data, '$.content') IS NULL OR (json_type(NEW.data, '$.content') = 'array' AND json_array_length(NEW.data, '$.content') <= 1024)) ELSE 0 END) OR NEW.type NOT IN ('assistant', 'tool', 'text', 'reasoning'))) OR OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.type IS NOT NEW.type OR OLD.seq IS NOT NEW.seq OR OLD.time_created IS NOT NEW.time_created OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.agent') IS NOT json_extract(NEW.data, '$.agent') OR json_extract(OLD.data, '$.model') IS NOT json_extract(NEW.data, '$.model') OR json_extract(OLD.data, '$.parentID') IS NOT json_extract(NEW.data, '$.parentID') OR json_extract(OLD.data, '$.request') IS NOT json_extract(NEW.data, '$.request') OR json_extract(OLD.data, '$.metadata') IS NOT json_extract(NEW.data, '$.metadata') OR json_extract(OLD.data, '$.id') IS NOT json_extract(NEW.data, '$.id') OR json_extract(OLD.data, '$.name') IS NOT json_extract(NEW.data, '$.name') OR json_extract(OLD.data, '$.state.input') IS NOT json_extract(NEW.data, '$.state.input') OR json_extract(OLD.data, '$.time.created') IS NOT json_extract(NEW.data, '$.time.created')) ELSE 1 END OR CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) AND (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_extract(OLD.data, '$.state.status') IN ('completed', 'error') AND (json_extract(OLD.data, '$.state') IS NOT json_extract(NEW.data, '$.state'))) ELSE 1 END OR CASE WHEN (CASE WHEN (CASE WHEN length(CAST(OLD.data AS BLOB)) <= 2097152 THEN json_valid(OLD.data) ELSE 0 END) THEN (json_type(OLD.data, '$.content') IS NULL OR (json_type(OLD.data, '$.content') = 'array' AND json_array_length(OLD.data, '$.content') <= 1024)) ELSE 0 END) AND (CASE WHEN (CASE WHEN length(CAST(NEW.data AS BLOB)) <= 2097152 THEN json_valid(NEW.data) ELSE 0 END) THEN (json_type(NEW.data, '$.content') IS NULL OR (json_type(NEW.data, '$.content') = 'array' AND json_array_length(NEW.data, '$.content') <= 1024)) ELSE 0 END) THEN (CASE
          WHEN json_type(OLD.data, '$.content') IS NULL THEN '[]'
          WHEN json_type(OLD.data, '$.content') IS NOT 'array' THEN OLD.data
          ELSE (SELECT json_group_array(CASE WHEN json_valid(value) THEN json_object(
            'id', json_extract(value, '$.id'), 'name', json_extract(value, '$.name'),
            'input', json_extract(value, '$.state.input'), 'created', json_extract(value, '$.time.created'),
            'terminal', CASE WHEN json_extract(items.value, '$.id') IN (
              SELECT CASE WHEN json_valid(previous.value) THEN json_extract(previous.value, '$.id') ELSE NULL END
              FROM json_each(OLD.data, '$.content') AS previous
              WHERE CASE WHEN json_valid(previous.value) THEN
                json_extract(previous.value, '$.type') = 'tool'
                AND json_extract(previous.value, '$.state.status') IN ('completed', 'error')
              ELSE 0 END
            ) THEN json_object('state', json_extract(value, '$.state'), 'time', json_extract(value, '$.time'), 'provider', json_extract(value, '$.provider')) ELSE NULL END
          ) ELSE json_object('invalid', value) END)
          FROM json_each(OLD.data, '$.content') AS items
          WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') = 'tool' ELSE 1 END)
        END IS NOT CASE
          WHEN json_type(NEW.data, '$.content') IS NULL THEN '[]'
          WHEN json_type(NEW.data, '$.content') IS NOT 'array' THEN NEW.data
          ELSE (SELECT json_group_array(CASE WHEN json_valid(value) THEN json_object(
            'id', json_extract(value, '$.id'), 'name', json_extract(value, '$.name'),
            'input', json_extract(value, '$.state.input'), 'created', json_extract(value, '$.time.created'),
            'terminal', CASE WHEN json_extract(items.value, '$.id') IN (
              SELECT CASE WHEN json_valid(previous.value) THEN json_extract(previous.value, '$.id') ELSE NULL END
              FROM json_each(OLD.data, '$.content') AS previous
              WHERE CASE WHEN json_valid(previous.value) THEN
                json_extract(previous.value, '$.type') = 'tool'
                AND json_extract(previous.value, '$.state.status') IN ('completed', 'error')
              ELSE 0 END
            ) THEN json_object('state', json_extract(value, '$.state'), 'time', json_extract(value, '$.time'), 'provider', json_extract(value, '$.provider')) ELSE NULL END
          ) ELSE json_object('invalid', value) END)
          FROM json_each(NEW.data, '$.content') AS items
          WHERE CASE WHEN json_valid(value) THEN json_extract(value, '$.type') = 'tool' ELSE 1 END)
        END) ELSE 1 END)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_message_delete
        BEFORE DELETE ON session_message
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_input_insert
        AFTER INSERT ON session_input
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_input_update
        AFTER UPDATE ON session_input
        WHEN (OLD.id IS NOT NEW.id OR OLD.session_id IS NOT NEW.session_id OR OLD.prompt IS NOT NEW.prompt OR OLD.delivery IS NOT NEW.delivery OR OLD.admitted_seq IS NOT NEW.admitted_seq OR OLD.promoted_seq IS NOT NEW.promoted_seq) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_input_delete
        BEFORE DELETE ON session_input
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_context_epoch_insert
        AFTER INSERT ON session_context_epoch
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_context_epoch_update
        AFTER UPDATE ON session_context_epoch
        WHEN (OLD.session_id IS NOT NEW.session_id OR OLD.baseline IS NOT NEW.baseline OR OLD.snapshot IS NOT NEW.snapshot OR OLD.baseline_seq IS NOT NEW.baseline_seq) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_session_context_epoch_delete
        BEFORE DELETE ON session_context_epoch
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_permission_insert
        AFTER INSERT ON permission
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_permission_update
        AFTER UPDATE ON permission
        WHEN (OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.action IS NOT NEW.action OR OLD.resource IS NOT NEW.resource) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_permission_delete
        BEFORE DELETE ON permission
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_insert
        AFTER INSERT ON project
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_update
        AFTER UPDATE ON project
        WHEN (OLD.id IS NOT NEW.id OR OLD.worktree IS NOT NEW.worktree OR OLD.vcs IS NOT NEW.vcs OR OLD.sandboxes IS NOT NEW.sandboxes OR OLD.commands IS NOT NEW.commands) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id, NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id, NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.id, NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id, NEW.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id, NEW.id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_delete
        BEFORE DELETE ON project
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_directory_insert
        AFTER INSERT ON project_directory
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (NEW.project_id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_directory_update
        AFTER UPDATE ON project_directory
        WHEN (OLD.project_id IS NOT NEW.project_id OR OLD.directory IS NOT NEW.directory OR OLD.type IS NOT NEW.type OR OLD.strategy IS NOT NEW.strategy) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id, NEW.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id, NEW.project_id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_project_directory_delete
        BEFORE DELETE ON project_directory
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))))
            ) OR (session IN (SELECT id FROM session WHERE project_id IN (OLD.project_id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'session' AND principal IN (SELECT id FROM session WHERE project_id IN (OLD.project_id))) OR (kind = 'workspace' AND principal IN (SELECT id FROM workspace WHERE project_id IN (OLD.project_id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_workspace_insert
        AFTER INSERT ON workspace
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'workspace' AND principal IN (NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE workspace_id IN (NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'workspace' AND principal IN (NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (NEW.id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_workspace_update
        AFTER UPDATE ON workspace
        WHEN (OLD.id IS NOT NEW.id OR OLD.type IS NOT NEW.type OR OLD.branch IS NOT NEW.branch OR OLD.directory IS NOT NEW.directory OR OLD.extra IS NOT NEW.extra OR OLD.project_id IS NOT NEW.project_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id, NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id, NEW.id))))
            ) OR (session IN (SELECT id FROM session WHERE workspace_id IN (OLD.id, NEW.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id, NEW.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id, NEW.id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_workspace_delete
        BEFORE DELETE ON workspace
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id))))
            ) OR (session IN (SELECT id FROM session WHERE workspace_id IN (OLD.id)))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'workspace' AND principal IN (OLD.id)) OR (kind = 'session' AND principal IN (SELECT id FROM session WHERE workspace_id IN (OLD.id))));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_conversation_insert
        AFTER INSERT ON raya_routine_conversation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_conversation_update
        AFTER UPDATE ON raya_routine_conversation
        WHEN (OLD.agent_id IS NOT NEW.agent_id OR OLD.id IS NOT NEW.id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_conversation_delete
        BEFORE DELETE ON raya_routine_conversation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_message_insert
        AFTER INSERT ON raya_routine_message
        WHEN (NEW.kind NOT IN ('worker', 'report'))
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_message_update
        AFTER UPDATE ON raya_routine_message
        WHEN (OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.source IS NOT NEW.source OR OLD.kind IS NOT NEW.kind OR OLD.body IS NOT NEW.body OR OLD.occurrence_id IS NOT NEW.occurrence_id OR OLD.session_id IS NOT NEW.session_id OR OLD.files IS NOT NEW.files OR OLD.attachments IS NOT NEW.attachments OR OLD.delivery_id IS NOT NEW.delivery_id) AND ((OLD.kind NOT IN ('worker', 'report') OR NEW.kind NOT IN ('worker', 'report')) OR OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.source IS NOT NEW.source OR OLD.kind IS NOT NEW.kind OR OLD.session_id IS NOT NEW.session_id OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_message_delete
        BEFORE DELETE ON raya_routine_message
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_attachment_insert
        AFTER INSERT ON raya_routine_attachment
        WHEN (NEW.message_id IS NOT NULL)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_attachment_update
        AFTER UPDATE ON raya_routine_attachment
        WHEN (OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.message_id IS NOT NEW.message_id OR OLD.name IS NOT NEW.name OR OLD.mime IS NOT NEW.mime OR OLD.size IS NOT NEW.size OR OLD.data IS NOT NEW.data OR OLD.sha256 IS NOT NEW.sha256) AND ((OLD.message_id IS NOT NULL OR NEW.message_id IS NOT NULL) OR OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.message_id IS NOT NEW.message_id OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_attachment_delete
        BEFORE DELETE ON raya_routine_attachment
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_occurrence_insert
        AFTER INSERT ON raya_routine_occurrence
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_occurrence_update
        AFTER UPDATE ON raya_routine_occurrence
        WHEN (OLD.id IS NOT NEW.id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.schedule_version IS NOT NEW.schedule_version OR OLD.scheduled_at IS NOT NEW.scheduled_at OR OLD.timezone IS NOT NEW.timezone OR OLD.state IS NOT NEW.state OR OLD.claim_id IS NOT NEW.claim_id OR OLD.owner IS NOT NEW.owner OR OLD.session_id IS NOT NEW.session_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_occurrence_delete
        BEFORE DELETE ON raya_routine_occurrence
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_delegation_insert
        AFTER INSERT ON raya_routine_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'delegation' AND principal IN (NEW.id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'run' AND principal IN (NEW.parent_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (run IN (NEW.parent_run_id, NEW.child_run_id) OR session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'delegation' AND principal IN (NEW.id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'run' AND principal IN (NEW.parent_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_delegation_update
        AFTER UPDATE ON raya_routine_delegation
        WHEN (OLD.id IS NOT NEW.id OR OLD.source IS NOT NEW.source OR OLD.sender_id IS NOT NEW.sender_id OR OLD.recipient_id IS NOT NEW.recipient_id OR OLD.parent_id IS NOT NEW.parent_id OR OLD.parent_run_id IS NOT NEW.parent_run_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.organization_revision IS NOT NEW.organization_revision OR OLD.workspace IS NOT NEW.workspace OR OLD.objective IS NOT NEW.objective OR OLD.expected IS NOT NEW.expected OR OLD.context IS NOT NEW.context OR OLD.deadline IS NOT NEW.deadline OR OLD.budget IS NOT NEW.budget OR OLD.depth IS NOT NEW.depth OR OLD.state IS NOT NEW.state OR OLD.child_run_id IS NOT NEW.child_run_id OR OLD.session_id IS NOT NEW.session_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id, NEW.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, NEW.parent_run_id, OLD.child_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (run IN (OLD.parent_run_id, NEW.parent_run_id, OLD.child_run_id, NEW.child_run_id) OR session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id, NEW.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, NEW.parent_run_id, OLD.child_run_id, NEW.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_delegation_delete
        BEFORE DELETE ON raya_routine_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, OLD.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (run IN (OLD.parent_run_id, OLD.child_run_id) OR session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'delegation' AND principal IN (OLD.id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)) OR (kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'run' AND principal IN (OLD.parent_run_id, OLD.child_run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_insert
        AFTER INSERT ON raya_routine_organization
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_update
        AFTER UPDATE ON raya_routine_organization
        WHEN (OLD.id IS NOT NEW.id OR OLD.name IS NOT NEW.name OR OLD.purpose IS NOT NEW.purpose OR OLD.policy IS NOT NEW.policy OR OLD.budget IS NOT NEW.budget OR OLD.revision IS NOT NEW.revision OR OLD.archived_at IS NOT NEW.archived_at OR OLD.stopping_at IS NOT NEW.stopping_at OR OLD.stopped_at IS NOT NEW.stopped_at) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id, NEW.id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id, NEW.id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delete
        BEFORE DELETE ON raya_routine_organization
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_member_insert
        AFTER INSERT ON raya_routine_organization_member
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id, NEW.supervisor_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id, NEW.supervisor_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_member_update
        AFTER UPDATE ON raya_routine_organization_member
        WHEN (OLD.organization_id IS NOT NEW.organization_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.role IS NOT NEW.role OR OLD.position IS NOT NEW.position OR OLD.supervisor_id IS NOT NEW.supervisor_id) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id, OLD.supervisor_id, NEW.supervisor_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id, OLD.supervisor_id, NEW.supervisor_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_member_delete
        BEFORE DELETE ON raya_routine_organization_member
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, OLD.supervisor_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, OLD.supervisor_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delegation_insert
        AFTER INSERT ON raya_routine_organization_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.sender_id, NEW.recipient_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delegation_update
        AFTER UPDATE ON raya_routine_organization_delegation
        WHEN (OLD.organization_id IS NOT NEW.organization_id OR OLD.sender_id IS NOT NEW.sender_id OR OLD.recipient_id IS NOT NEW.recipient_id OR OLD.position IS NOT NEW.position) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, NEW.sender_id, OLD.recipient_id, NEW.recipient_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_delegation_delete
        BEFORE DELETE ON raya_routine_organization_delegation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.sender_id, OLD.recipient_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_revision_insert
        AFTER INSERT ON raya_routine_organization_revision
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_revision_update
        AFTER UPDATE ON raya_routine_organization_revision
        WHEN (OLD.organization_id IS NOT NEW.organization_id OR OLD.revision IS NOT NEW.revision OR OLD.definition IS NOT NEW.definition) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_revision_delete
        BEFORE DELETE ON raya_routine_organization_revision
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_reservation_insert
        AFTER INSERT ON raya_routine_organization_reservation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'run' AND principal IN (NEW.run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            ) OR (run IN (NEW.run_id) OR session IN (NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'principal' AND principal IN (NEW.agent_id)) OR (kind = 'run' AND principal IN (NEW.run_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_reservation_update
        AFTER UPDATE ON raya_routine_organization_reservation
        WHEN (OLD.run_id IS NOT NEW.run_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.organization_revision IS NOT NEW.organization_revision OR OLD.session_id IS NOT NEW.session_id OR OLD.budget IS NOT NEW.budget OR OLD.cost IS NOT NEW.cost OR OLD.state IS NOT NEW.state) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id, NEW.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            ) OR (run IN (OLD.run_id, NEW.run_id) OR session IN (OLD.session_id, NEW.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id, NEW.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id, NEW.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_reservation_delete
        BEFORE DELETE ON raya_routine_organization_reservation
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            ) OR (run IN (OLD.run_id) OR session IN (OLD.session_id))
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'principal' AND principal IN (OLD.agent_id)) OR (kind = 'run' AND principal IN (OLD.run_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_coordinator_insert
        AFTER INSERT ON raya_routine_organization_coordinator
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'session' AND principal IN (NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (NEW.organization_id)) OR (kind = 'session' AND principal IN (NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_coordinator_update
        AFTER UPDATE ON raya_routine_organization_coordinator
        WHEN (OLD.message_id IS NOT NEW.message_id OR OLD.session_id IS NOT NEW.session_id OR OLD.organization_id IS NOT NEW.organization_id OR OLD.organization_revision IS NOT NEW.organization_revision OR OLD.state IS NOT NEW.state) AND (1 OR 0 OR 0 OR 0 OR 0)
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id, NEW.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id, NEW.session_id)));
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER raya_routine_authority_raya_routine_organization_coordinator_delete
        BEFORE DELETE ON raya_routine_organization_coordinator
        WHEN 1
        BEGIN
          UPDATE raya_routine_effect_capsule SET state = 'revoked'
          WHERE state = 'active' AND (
            id IN (
              SELECT m.capsule FROM raya_routine_effect_membership AS m
              JOIN raya_routine_effect_scope AS s ON s.id = m.scope AND s.generation = m.generation
              WHERE s.state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id)))
            )
          );
          UPDATE raya_routine_effect_scope SET state = 'revoking'
          WHERE state = 'active' AND ((kind = 'organization' AND principal IN (OLD.organization_id)) OR (kind = 'session' AND principal IN (OLD.session_id)));
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
