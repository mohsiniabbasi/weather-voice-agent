// scripts/test-weather.js
// Quick local sanity check with NO deploy and NO accounts required.
// Run:  node scripts/test-weather.js  Dewsbury
//       node scripts/test-weather.js  "Reykjavik"
// It prints the weather + whether the cold rule fired.

const { getCurrentWeather } = require("../lib/weather");

async function main() {
  const town = process.argv[2] || "Dewsbury";
  console.log(`Looking up weather for: ${town}\n`);
  try {
    const w = await getCurrentWeather(town);
    console.log(`  Town:        ${w.town}, ${w.country}`);
    console.log(`  Temperature: ${w.tempC}°C`);
    console.log(`  Conditions:  ${w.description}`);
    console.log(`  Cold (<${w.thresholdC}°C)? ${w.isCold ? "YES — would send coat reminder" : "no"}`);
  } catch (e) {
    console.error(`  ERROR (${e.code || "unknown"}): ${e.message}`);
    process.exit(1);
  }
}

main();
