// lib/weather.js
// Talks to Open-Meteo (free, no API key). Two steps:
//   1) geocode: turn a town name into latitude/longitude
//   2) forecast: get the current temperature for those coordinates
// Then it applies the customer's rule: "below 10°C = cold".

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather codes -> plain-English description (only the common ones).
// Open-Meteo returns a numeric "weather_code"; we translate it so the
// voice agent can say "cloudy" instead of "code 3".
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
  return map[code] || "unclear conditions";
}

// Step 1: town name -> coordinates.
async function geocode(town) {
  const url = `${GEO_URL}?name=${encodeURIComponent(town)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding request failed: HTTP ${res.status}`);

  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    // Custom error code so the caller (api/weather.js) can give the user
    // a friendly "I couldn't find that town" instead of a generic crash.
    const err = new Error(`Town not found: ${town}`);
    err.code = "TOWN_NOT_FOUND";
    throw err;
  }

  const place = data.results[0];
  return {
    name: place.name,
    country: place.country,
    lat: place.latitude,
    lon: place.longitude,
  };
}

// Step 2 (+ the business rule): get current weather and decide if it's cold.
async function getCurrentWeather(town, coldThresholdC = 10) {
  const place = await geocode(town);

  const url =
    `${FORECAST_URL}?latitude=${place.lat}&longitude=${place.lon}` +
    `&current=temperature_2m,weather_code&temperature_unit=celsius`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Forecast request failed: HTTP ${res.status}`);

  const data = await res.json();
  const tempC = data.current.temperature_2m;
  const code = data.current.weather_code;

  return {
    town: place.name,
    country: place.country,
    tempC,
    description: describeWeather(code),
    isCold: tempC < coldThresholdC,
    thresholdC: coldThresholdC,
  };
}

module.exports = { getCurrentWeather, geocode, describeWeather };
