/**
 * The fifty states, and the District of Columbia as an optional extra.
 *
 * Same row shape as countries.mjs, with `atlas` the two-digit FIPS code that
 * us-atlas keys its shapes by. Regions are the Census Bureau's four, with New
 * England and the Mid-Atlantic split out of the Northeast because "just New
 * England" is the scope people actually want: six small states that are the
 * hard part of the map.
 */

const s = (code, fips, name, region, capital, accepts = [], tags = []) => ({
  key: `US-${code}`, atlas: fips, name, accepts, continents: ['us'], region, capital, tags,
});

export const STATES = [
  s('AL', '01', 'Alabama', 'south', ['Montgomery', -86.3, 32.38]),
  s('AK', '02', 'Alaska', 'west', ['Juneau', -134.42, 58.3]),
  s('AZ', '04', 'Arizona', 'west', ['Phoenix', -112.07, 33.45]),
  s('AR', '05', 'Arkansas', 'south', ['Little Rock', -92.29, 34.75]),
  s('CA', '06', 'California', 'west', ['Sacramento', -121.49, 38.58]),
  s('CO', '08', 'Colorado', 'west', ['Denver', -104.99, 39.74]),
  s('CT', '09', 'Connecticut', 'new-england', ['Hartford', -72.68, 41.76]),
  s('DE', '10', 'Delaware', 'south', ['Dover', -75.52, 39.16]),
  s('FL', '12', 'Florida', 'south', ['Tallahassee', -84.28, 30.44]),
  s('GA', '13', 'Georgia', 'south', ['Atlanta', -84.39, 33.75]),
  s('HI', '15', 'Hawaii', 'west', ['Honolulu', -157.86, 21.31], ["Hawai'i"]),
  s('ID', '16', 'Idaho', 'west', ['Boise', -116.2, 43.62]),
  s('IL', '17', 'Illinois', 'midwest', ['Springfield', -89.65, 39.8]),
  s('IN', '18', 'Indiana', 'midwest', ['Indianapolis', -86.16, 39.77]),
  s('IA', '19', 'Iowa', 'midwest', ['Des Moines', -93.61, 41.59]),
  s('KS', '20', 'Kansas', 'midwest', ['Topeka', -95.68, 39.05]),
  s('KY', '21', 'Kentucky', 'south', ['Frankfort', -84.87, 38.2]),
  s('LA', '22', 'Louisiana', 'south', ['Baton Rouge', -91.14, 30.45]),
  s('ME', '23', 'Maine', 'new-england', ['Augusta', -69.78, 44.31]),
  s('MD', '24', 'Maryland', 'south', ['Annapolis', -76.49, 38.98]),
  s('MA', '25', 'Massachusetts', 'new-england', ['Boston', -71.06, 42.36]),
  s('MI', '26', 'Michigan', 'midwest', ['Lansing', -84.56, 42.73]),
  s('MN', '27', 'Minnesota', 'midwest', ['Saint Paul', -93.09, 44.95]),
  s('MS', '28', 'Mississippi', 'south', ['Jackson', -90.18, 32.3]),
  s('MO', '29', 'Missouri', 'midwest', ['Jefferson City', -92.17, 38.58]),
  s('MT', '30', 'Montana', 'west', ['Helena', -112.03, 46.59]),
  s('NE', '31', 'Nebraska', 'midwest', ['Lincoln', -96.7, 40.81]),
  s('NV', '32', 'Nevada', 'west', ['Carson City', -119.77, 39.16]),
  s('NH', '33', 'New Hampshire', 'new-england', ['Concord', -71.54, 43.21]),
  s('NJ', '34', 'New Jersey', 'mid-atlantic', ['Trenton', -74.76, 40.22]),
  s('NM', '35', 'New Mexico', 'west', ['Santa Fe', -105.94, 35.69]),
  s('NY', '36', 'New York', 'mid-atlantic', ['Albany', -73.76, 42.65]),
  s('NC', '37', 'North Carolina', 'south', ['Raleigh', -78.64, 35.78]),
  s('ND', '38', 'North Dakota', 'midwest', ['Bismarck', -100.78, 46.81]),
  s('OH', '39', 'Ohio', 'midwest', ['Columbus', -83.0, 39.96]),
  s('OK', '40', 'Oklahoma', 'south', ['Oklahoma City', -97.52, 35.47]),
  s('OR', '41', 'Oregon', 'west', ['Salem', -123.04, 44.94]),
  s('PA', '42', 'Pennsylvania', 'mid-atlantic', ['Harrisburg', -76.88, 40.26]),
  s('RI', '44', 'Rhode Island', 'new-england', ['Providence', -71.41, 41.82]),
  s('SC', '45', 'South Carolina', 'south', ['Columbia', -81.03, 34.0]),
  s('SD', '46', 'South Dakota', 'midwest', ['Pierre', -100.35, 44.37]),
  s('TN', '47', 'Tennessee', 'south', ['Nashville', -86.78, 36.16]),
  s('TX', '48', 'Texas', 'south', ['Austin', -97.74, 30.27]),
  s('UT', '49', 'Utah', 'west', ['Salt Lake City', -111.89, 40.76]),
  s('VT', '50', 'Vermont', 'new-england', ['Montpelier', -72.58, 44.26]),
  s('VA', '51', 'Virginia', 'south', ['Richmond', -77.44, 37.54]),
  s('WA', '53', 'Washington', 'west', ['Olympia', -122.9, 47.04], ['Washington State']),
  s('WV', '54', 'West Virginia', 'south', ['Charleston', -81.63, 38.35]),
  s('WI', '55', 'Wisconsin', 'midwest', ['Madison', -89.4, 43.07]),
  s('WY', '56', 'Wyoming', 'west', ['Cheyenne', -104.82, 41.14]),
  // Not a state, so off by default and never asked for a capital. Tagged
  // `territory` so it rides the same switch as Greenland and Puerto Rico.
  s('DC', '11', 'District of Columbia', 'south', null, ['DC', 'Washington DC', 'Washington, D.C.'], ['territory']),
];
