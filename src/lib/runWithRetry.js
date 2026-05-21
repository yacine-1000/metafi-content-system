async function runWithRetry({ label, maxAttempts = 3, baseDelayMs = 1000, shouldRetry, fn }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        const delay = baseDelayMs * (attempt - 1);
        console.log(`[${label}] Retry ${attempt}/${maxAttempts} in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (shouldRetry && !shouldRetry(err, attempt)) break;
      if (attempt < maxAttempts) console.log(`[${label}] Attempt ${attempt} failed: ${err.message}`);
    }
  }
  throw lastError;
}

module.exports = { runWithRetry };
