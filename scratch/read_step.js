import fs from 'fs';
import readline from 'readline';

async function checkLine() {
  const fileStream = fs.createReadStream("C:/Users/suraj/.gemini/antigravity/brain/746d58e4-32c7-4475-8bda-831808187e8c/.system_generated/logs/transcript.jsonl");
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  let idx = 0;
  for await (const line of rl) {
    idx++;
    if (idx >= 1426 && idx <= 1435) {
      const parsed = JSON.parse(line);
      console.log(`Line ${idx} [${parsed.type}] (${parsed.source}):`, typeof parsed.content === "string" ? parsed.content.slice(0, 300) : "no content");
    }
  }
}
checkLine();

