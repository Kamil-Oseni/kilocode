/** Join the generated SSE reader's original cancellation without losing a read failure. */
export function sse(source: string) {
  const rows = [
    [
      `        const abortHandler = () => {
          try {
            reader.cancel();
          } catch {
            // noop
          }
        };`,
      `        let cancellation: Promise<{ error: unknown } | undefined> | undefined;
        let failure: { error: unknown } | undefined;
        const abortHandler = () => {
          cancellation ??= Promise.resolve().then(() => reader.cancel()).then(
            () => undefined,
            (error: unknown) => ({ error }),
          );
        };`,
    ],
    [
      `        } finally {
          signal.removeEventListener('abort', abortHandler);
          reader.releaseLock();
        }`,
      `        } catch (error) {
          failure = { error };
          throw error;
        } finally {
          signal.removeEventListener('abort', abortHandler);
          const cancelled = await cancellation;
          reader.releaseLock();
          if (cancelled && (!failure || cancelled.error !== failure.error)) {
            throw failure
              ? new AggregateError([failure.error, cancelled.error], 'SSE read and cancellation failed')
              : cancelled.error;
          }
        }`,
    ],
  ] as const
  return rows.reduce((text, [before, after]) => {
    if (text.split(before).length !== 2) throw new Error("SSE cancellation patch requires exact generator output")
    return text.replace(before, after)
  }, source)
}
