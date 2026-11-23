/** Poll short HTTP requests so Heroku never waits for chain confirmation in one request. */
export async function confirmTransaction(signature: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `/api/transaction-status?signature=${encodeURIComponent(signature)}`,
      {
        signal: AbortSignal.timeout(10_000),
      }
    ).catch((): null => null);
    if (response?.ok) {
      const status = await response.json();
      if (status.failed) throw new Error(`Transaction failed. Signature: ${signature}`);
      if (status.confirmed) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Confirmation is pending. Check this signature in your wallet before retrying: ${signature}`
  );
}
