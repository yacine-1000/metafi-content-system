require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { runWithRetry } = require('./runWithRetry');
const { saveAttemptLog } = require('./saveAttemptLog');

async function callGeminiJson({ root, phaseName, message, validate, modelName = 'gemini-2.5-flash', temperature = 0.2, maxAttempts = 3 }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set in .env');
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { responseMimeType: 'application/json', temperature } });

  return runWithRetry({ label: phaseName, maxAttempts, fn: async (attempt) => {
    const result = await model.generateContent(message);
    const text = result.response.text();
    saveAttemptLog({ root, phaseName, attemptNumber: attempt, responseText: text });

    let parsed;
    try { parsed = JSON.parse(text); } catch (e) {
      const err = new Error(`Invalid JSON returned by Gemini in ${phaseName}`);
      saveAttemptLog({ root, phaseName, attemptNumber: attempt, error: err });
      throw err;
    }

    if (validate) {
      const validationErrors = validate(parsed);
      if (validationErrors) {
        const err = new Error(`Validation failed in ${phaseName}`);
        err.validationErrors = validationErrors;
        saveAttemptLog({ root, phaseName, attemptNumber: attempt, error: err });
        throw err;
      }
    }

    saveAttemptLog({ root, phaseName, attemptNumber: attempt, parsed });
    return parsed;
  }});
}

module.exports = { callGeminiJson };
