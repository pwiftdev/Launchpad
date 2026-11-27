// Runs once when the Node.js server starts. With DISPLAY_INDEXER=true this process also offers
// to run the display indexer; an advisory lock lets only one process index at a time.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.DISPLAY_INDEXER !== 'true') return;
    const { startDisplayIndexer } = await import('./server/indexer/run');
    void startDisplayIndexer();
  }
}
