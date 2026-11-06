export default async function globalTeardown(): Promise<void> {
  await Promise.all(
    (globalThis.__STOCKPILOT_CONTAINERS__ ?? []).map((container) =>
      container.stop(),
    ),
  );
}
