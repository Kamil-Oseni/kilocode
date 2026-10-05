/** Expected tool refusal; never use this type for storage, provider or finalizer failures. */
export class Refusal extends Error {
  static readonly access =
    "The selected specialist cannot perform the requested work class. If Chief omitted access and no child has started, call chief_route with the same complete request and explicit access before retrying Task."
  static readonly resume =
    "The requested task session does not exist. Omit task_id for a fresh delegation; refine an incompatible Chief decision with chief_route before retrying Task."
  constructor(
    readonly reason:
      | "stale-edit"
      | "parent-edit-policy"
      | "task-objective"
      | "read-missing"
      | "task-access"
      | "task-resume",
    message: string,
  ) {
    if (
      reason !== "stale-edit" &&
      reason !== "parent-edit-policy" &&
      reason !== "task-objective" &&
      reason !== "read-missing" &&
      reason !== "task-access" &&
      reason !== "task-resume"
    )
      throw new Error("Invalid tool refusal reason")
    super(message)
  }
}
