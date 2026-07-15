// lib/weather.js
// ─────────────────────────────────────────────────────────────────────────────
// Talks to Open-Meteo (free, no API key). Two steps:
//   1) geocode:  turn a town name into latitude/longitude
//   2) forecast: get the current temperature for those coordinates
// Then it applies the customer's rule: "below 10°C = cold".
// ─────────────────────────────────────────────────────────────────────────────

// The two Open-Meteo endpoints we call (one to find the place, one for weather).
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather codes -> plain-English description (only the common ones).
// Open-Meteo returns a numeric "weather_code"; we translate it so the voice
// agent can say "overcast" instead of "code 3".
function describeWeather(code) {
  const map = {
    0: "clear sky",
    1: "mainly clear",
    2: "partly cloudy",
    3: "overcast",
    45: "foggy",
    48: "freezing fog",
    51: "light drizzle",
    53: "drizzle",
    55: "heavy drizzle",
    61: "light rain",
    63: "rain",
    65: "heavy rain",
    71: "light snow",
    73: "snow",
    75: "heavy snow",
    80: "rain showers",
    81: "rain showers",
    82: "violent rain showers",
    95: "thunderstorms",
  };
  return map[code] || "unclear conditions"; // safe default for any code we don't map
}

// Step 1: town name -> coordinates.
async function geocode(town) {
  // Build the request URL. encodeURIComponent makes the town name URL-safe;
  // count=1 asks for just the single best match.
  const url = `${GEO_URL}?name=${encodeURIComponent(town)}&count=1&language=en&format=json`;
  const res = await fetch(url);                       // call the geocoding API and wait
  if (!res.ok) throw new Error(`Geocoding request failed: HTTP ${res.status}`); // non-2xx = fail loudly

  const data = await res.json();                      // parse the JSON response
  if (!data.results || data.results.length === 0) {
    // No match. Throw a TYPED error (custom .code) so the caller (api/weather.js)
    // can say a friendly "I couldn't find that town" instead of a generic crash.
    const err = new Error(`Town not found: ${town}`);
    err.code = "TOWN_NOT_FOUND";
    throw err;
  }

  // Return just the fields we care about from the top match.
  const place = data.results[0];
  return {
    name: place.name,
    country: place.country,
    lat: place.latitude,
    lon: place.longitude,
  };
}

// Step 2 (+ the business rule): get current weather and decide if it's cold.
// coldThresholdC defaults to 10 but is a parameter, so the rule is configurable.
async function getCurrentWeather(town, coldThresholdC = 10) {
  const place = await geocode(town); // must geocode first — the forecast needs coordinates

  // Ask for the current temperature (°C) and weather code at those coordinates.
  const url =
    `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,weather_code&temperature_unit=celsius`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast request failed: HTTP ${res.status}`);

  const data = await res.json();
  const tempC = data.current.temperature_2m; // the raw temperature
  const code = data.current.weather_code;     // the numeric conditions code

  // Hand back a tidy object. Note: isCold uses a STRICT < , so exactly 10.0°C is
  // NOT cold — a deliberate boundary decision, easy to flip to <= if needed.
  return {
    town: place.name,
    country: place.country,
    tempC,
    description: describeWeather(code),
    isCold: tempC < coldThresholdC,
    thresholdC: coldThresholdC,
  };
}

// Expose the functions other files use.
module.exports = { getCurrentWeather, geocode, describeWeather };
