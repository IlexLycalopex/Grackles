/**
 * Every country and territory Gazetteer can ask about, and the judgement calls
 * that go with them.
 *
 * This is the file to review. build-gazetteer.mjs turns it into
 * src/data/gazetteer/*.json, and everything in those files that is not
 * geometry came from here: names, alternative names, regions, capitals.
 *
 * Row shape:
 *   key        ISO 3166-1 alpha-3, or XKX for Kosovo, which has none.
 *   atlas      the world-atlas feature: its numeric id, or its name where there
 *              is no id. null for a place the atlas does not draw (Tuvalu),
 *              which is then played as a dot at `at`.
 *   name       the answer shown. Current UK Foreign Office usage where it has
 *              one, the common English name where it does not.
 *   accepts    other names marked correct. Case, accents, punctuation and a
 *              leading "the" are ignored before comparing, so they need not
 *              be listed here.
 *   continents every continent deck the place belongs to. Transcontinental
 *              countries list more than one; because a card is a fact, being in
 *              two decks costs nothing.
 *   region     one sub-region, used for scopes ("just the Balkans") and hints.
 *   tags       disputed | territory | nordic | baltics
 *   capital    [name, lon, lat, accepts?, also?]
 *              `also` is other official or commonly held capitals: accepted, and
 *              named on the reveal. null where there is no capital to ask.
 */

const c = (key, atlas, name, accepts, continents, region, capital, tags = []) => ({
  key, atlas, name, accepts, continents, region, capital, tags,
});

export const COUNTRIES = [
  // ── Africa ────────────────────────────────────────────────────────────
  c('DZA', '012', 'Algeria', [], ['africa'], 'north-africa', ['Algiers', 3.06, 36.75]),
  c('AGO', '024', 'Angola', [], ['africa'], 'central-africa', ['Luanda', 13.23, -8.84]),
  c('BEN', '204', 'Benin', [], ['africa'], 'west-africa', ['Porto-Novo', 2.63, 6.5, [], ['Cotonou']]),
  c('BWA', '072', 'Botswana', [], ['africa'], 'southern-africa', ['Gaborone', 25.91, -24.65]),
  c('BFA', '854', 'Burkina Faso', [], ['africa'], 'west-africa', ['Ouagadougou', -1.52, 12.37]),
  c('BDI', '108', 'Burundi', [], ['africa'], 'east-africa', ['Gitega', 29.92, -3.43, [], ['Bujumbura']]),
  c('CPV', '132', 'Cape Verde', ['Cabo Verde'], ['africa'], 'west-africa', ['Praia', -23.51, 14.93]),
  c('CMR', '120', 'Cameroon', [], ['africa'], 'central-africa', ['Yaoundé', 11.52, 3.87]),
  c('CAF', '140', 'Central African Republic', ['CAR'], ['africa'], 'central-africa', ['Bangui', 18.56, 4.39]),
  c('TCD', '148', 'Chad', [], ['africa'], 'central-africa', ["N'Djamena", 15.04, 12.13, ['Ndjamena']]),
  c('COM', '174', 'Comoros', [], ['africa'], 'east-africa', ['Moroni', 43.26, -11.7]),
  c('COG', '178', 'Republic of the Congo', ['Congo', 'Congo-Brazzaville', 'Congo Republic'], ['africa'], 'central-africa', ['Brazzaville', 15.28, -4.27]),
  c('COD', '180', 'Democratic Republic of the Congo', ['DRC', 'DR Congo', 'Congo-Kinshasa', 'DRC Congo'], ['africa'], 'central-africa', ['Kinshasa', 15.31, -4.33]),
  c('CIV', '384', "Côte d'Ivoire", ['Ivory Coast', 'Cote dIvoire'], ['africa'], 'west-africa', ['Yamoussoukro', -5.28, 6.82, [], ['Abidjan']]),
  c('DJI', '262', 'Djibouti', [], ['africa'], 'east-africa', ['Djibouti', 43.15, 11.59, ['Djibouti City']]),
  c('EGY', '818', 'Egypt', [], ['africa', 'asia'], 'north-africa', ['Cairo', 31.24, 30.04]),
  c('GNQ', '226', 'Equatorial Guinea', [], ['africa'], 'central-africa', ['Malabo', 8.78, 3.75, [], ['Ciudad de la Paz']]),
  c('ERI', '232', 'Eritrea', [], ['africa'], 'east-africa', ['Asmara', 38.93, 15.32]),
  c('SWZ', '748', 'Eswatini', ['Swaziland'], ['africa'], 'southern-africa', ['Mbabane', 31.13, -26.32, [], ['Lobamba']]),
  c('ETH', '231', 'Ethiopia', [], ['africa'], 'east-africa', ['Addis Ababa', 38.75, 9.03]),
  c('GAB', '266', 'Gabon', [], ['africa'], 'central-africa', ['Libreville', 9.45, 0.39]),
  c('GMB', '270', 'The Gambia', [], ['africa'], 'west-africa', ['Banjul', -16.58, 13.45]),
  c('GHA', '288', 'Ghana', [], ['africa'], 'west-africa', ['Accra', -0.19, 5.6]),
  c('GIN', '324', 'Guinea', ['Guinea-Conakry'], ['africa'], 'west-africa', ['Conakry', -13.68, 9.64]),
  c('GNB', '624', 'Guinea-Bissau', [], ['africa'], 'west-africa', ['Bissau', -15.6, 11.86]),
  c('KEN', '404', 'Kenya', [], ['africa'], 'east-africa', ['Nairobi', 36.82, -1.29]),
  c('LSO', '426', 'Lesotho', [], ['africa'], 'southern-africa', ['Maseru', 27.48, -29.31]),
  c('LBR', '430', 'Liberia', [], ['africa'], 'west-africa', ['Monrovia', -10.8, 6.3]),
  c('LBY', '434', 'Libya', [], ['africa'], 'north-africa', ['Tripoli', 13.19, 32.89]),
  c('MDG', '450', 'Madagascar', [], ['africa'], 'east-africa', ['Antananarivo', 47.52, -18.88]),
  c('MWI', '454', 'Malawi', [], ['africa'], 'east-africa', ['Lilongwe', 33.79, -13.96]),
  c('MLI', '466', 'Mali', [], ['africa'], 'west-africa', ['Bamako', -8.0, 12.64]),
  c('MRT', '478', 'Mauritania', [], ['africa'], 'west-africa', ['Nouakchott', -15.98, 18.08]),
  c('MUS', '480', 'Mauritius', [], ['africa'], 'east-africa', ['Port Louis', 57.5, -20.16]),
  c('MAR', '504', 'Morocco', [], ['africa'], 'north-africa', ['Rabat', -6.84, 34.02]),
  c('MOZ', '508', 'Mozambique', [], ['africa'], 'east-africa', ['Maputo', 32.57, -25.97]),
  c('NAM', '516', 'Namibia', [], ['africa'], 'southern-africa', ['Windhoek', 17.08, -22.56]),
  c('NER', '562', 'Niger', [], ['africa'], 'west-africa', ['Niamey', 2.11, 13.51]),
  c('NGA', '566', 'Nigeria', [], ['africa'], 'west-africa', ['Abuja', 7.49, 9.06]),
  c('RWA', '646', 'Rwanda', [], ['africa'], 'east-africa', ['Kigali', 30.06, -1.94]),
  c('STP', '678', 'São Tomé and Príncipe', ['Sao Tome'], ['africa'], 'central-africa', ['São Tomé', 6.73, 0.34]),
  c('SEN', '686', 'Senegal', [], ['africa'], 'west-africa', ['Dakar', -17.44, 14.69]),
  c('SYC', '690', 'Seychelles', [], ['africa'], 'east-africa', ['Victoria', 55.45, -4.62]),
  c('SLE', '694', 'Sierra Leone', [], ['africa'], 'west-africa', ['Freetown', -13.23, 8.48]),
  // Drawn with Somaliland inside it. Somaliland governs itself but no member
  // of the UN recognises it, and a quiz that asks for it by name is taking a
  // side the atlases mostly do not.
  c('SOM', '706', 'Somalia', [], ['africa'], 'east-africa', ['Mogadishu', 45.32, 2.05]),
  c('ZAF', '710', 'South Africa', [], ['africa'], 'southern-africa', ['Pretoria', 28.19, -25.75, ['Tshwane'], ['Cape Town', 'Bloemfontein']]),
  c('SSD', '728', 'South Sudan', [], ['africa'], 'east-africa', ['Juba', 31.58, 4.85]),
  c('SDN', '729', 'Sudan', [], ['africa'], 'north-africa', ['Khartoum', 32.53, 15.5]),
  c('TZA', '834', 'Tanzania', [], ['africa'], 'east-africa', ['Dodoma', 35.74, -6.16, [], ['Dar es Salaam']]),
  c('TGO', '768', 'Togo', [], ['africa'], 'west-africa', ['Lomé', 1.23, 6.13]),
  c('TUN', '788', 'Tunisia', [], ['africa'], 'north-africa', ['Tunis', 10.18, 36.81]),
  c('UGA', '800', 'Uganda', [], ['africa'], 'east-africa', ['Kampala', 32.58, 0.35]),
  c('ZMB', '894', 'Zambia', [], ['africa'], 'east-africa', ['Lusaka', 28.32, -15.39]),
  c('ZWE', '716', 'Zimbabwe', [], ['africa'], 'east-africa', ['Harare', 31.05, -17.83]),
  // No capital card: the claimed capital (Laayoune) is administered by
  // Morocco, and asking for it would be asking the player to pick a side.
  c('ESH', '732', 'Western Sahara', [], ['africa'], 'north-africa', null, ['disputed']),

  // ── Asia ──────────────────────────────────────────────────────────────
  c('AFG', '004', 'Afghanistan', [], ['asia'], 'south-asia', ['Kabul', 69.17, 34.53]),
  c('ARM', '051', 'Armenia', [], ['asia', 'europe'], 'caucasus', ['Yerevan', 44.51, 40.18]),
  c('AZE', '031', 'Azerbaijan', [], ['asia', 'europe'], 'caucasus', ['Baku', 49.87, 40.41]),
  c('BHR', '048', 'Bahrain', [], ['asia'], 'middle-east', ['Manama', 50.59, 26.23]),
  c('BGD', '050', 'Bangladesh', [], ['asia'], 'south-asia', ['Dhaka', 90.41, 23.81]),
  c('BTN', '064', 'Bhutan', [], ['asia'], 'south-asia', ['Thimphu', 89.64, 27.47]),
  c('BRN', '096', 'Brunei', ['Brunei Darussalam'], ['asia'], 'southeast-asia', ['Bandar Seri Begawan', 114.94, 4.9]),
  c('KHM', '116', 'Cambodia', [], ['asia'], 'southeast-asia', ['Phnom Penh', 104.92, 11.56]),
  c('CHN', '156', 'China', [], ['asia'], 'east-asia', ['Beijing', 116.4, 39.9]),
  // Drawn whole, Northern Cyprus included: the same reasoning as Somalia.
  c('CYP', '196', 'Cyprus', [], ['asia', 'europe'], 'middle-east', ['Nicosia', 33.38, 35.17]),
  c('GEO', '268', 'Georgia', [], ['asia', 'europe'], 'caucasus', ['Tbilisi', 44.79, 41.72]),
  c('IND', '356', 'India', [], ['asia'], 'south-asia', ['New Delhi', 77.21, 28.61, ['Delhi']]),
  c('IDN', '360', 'Indonesia', [], ['asia'], 'southeast-asia', ['Jakarta', 106.85, -6.21, [], ['Nusantara']]),
  c('IRN', '364', 'Iran', ['Persia'], ['asia'], 'middle-east', ['Tehran', 51.39, 35.69]),
  c('IRQ', '368', 'Iraq', [], ['asia'], 'middle-east', ['Baghdad', 44.36, 33.31]),
  // The capital most states' embassies sit in is Tel Aviv; the one Israel
  // names is Jerusalem. Both are accepted and both are named on the reveal.
  c('ISR', '376', 'Israel', [], ['asia'], 'middle-east', ['Jerusalem', 35.22, 31.77, [], ['Tel Aviv']]),
  c('JPN', '392', 'Japan', [], ['asia'], 'east-asia', ['Tokyo', 139.69, 35.69]),
  c('JOR', '400', 'Jordan', [], ['asia'], 'middle-east', ['Amman', 35.93, 31.95]),
  c('KAZ', '398', 'Kazakhstan', [], ['asia', 'europe'], 'central-asia', ['Astana', 71.45, 51.17, ['Nur-Sultan']]),
  c('KWT', '414', 'Kuwait', [], ['asia'], 'middle-east', ['Kuwait City', 47.98, 29.37, ['Kuwait']]),
  c('KGZ', '417', 'Kyrgyzstan', ['Kyrgyz Republic'], ['asia'], 'central-asia', ['Bishkek', 74.59, 42.87]),
  c('LAO', '418', 'Laos', ['Lao', 'Lao PDR'], ['asia'], 'southeast-asia', ['Vientiane', 102.63, 17.97]),
  c('LBN', '422', 'Lebanon', [], ['asia'], 'middle-east', ['Beirut', 35.5, 33.89]),
  c('MYS', '458', 'Malaysia', [], ['asia'], 'southeast-asia', ['Kuala Lumpur', 101.69, 3.14, [], ['Putrajaya']]),
  c('MDV', '462', 'Maldives', [], ['asia'], 'south-asia', ['Malé', 73.51, 4.18]),
  c('MNG', '496', 'Mongolia', [], ['asia'], 'east-asia', ['Ulaanbaatar', 106.92, 47.89, ['Ulan Bator']]),
  c('MMR', '104', 'Myanmar', ['Burma'], ['asia'], 'southeast-asia', ['Naypyidaw', 96.13, 19.76, ['Nay Pyi Taw', 'Naypyitaw']]),
  c('NPL', '524', 'Nepal', [], ['asia'], 'south-asia', ['Kathmandu', 85.32, 27.72]),
  c('PRK', '408', 'North Korea', ['DPRK'], ['asia'], 'east-asia', ['Pyongyang', 125.75, 39.02]),
  c('OMN', '512', 'Oman', [], ['asia'], 'middle-east', ['Muscat', 58.41, 23.59]),
  c('PAK', '586', 'Pakistan', [], ['asia'], 'south-asia', ['Islamabad', 73.05, 33.68]),
  // Ramallah is where the Palestinian Authority governs from; East Jerusalem
  // is the capital it claims. Both accepted, both named.
  c('PSE', '275', 'Palestine', ['Palestinian Territories', 'State of Palestine'], ['asia'], 'middle-east', ['Ramallah', 35.2, 31.9, [], ['East Jerusalem']], ['disputed']),
  c('PHL', '608', 'Philippines', [], ['asia'], 'southeast-asia', ['Manila', 120.98, 14.6]),
  c('QAT', '634', 'Qatar', [], ['asia'], 'middle-east', ['Doha', 51.53, 25.29]),
  c('SAU', '682', 'Saudi Arabia', [], ['asia'], 'middle-east', ['Riyadh', 46.72, 24.71]),
  c('SGP', '702', 'Singapore', [], ['asia'], 'southeast-asia', ['Singapore', 103.82, 1.35]),
  c('KOR', '410', 'South Korea', [], ['asia'], 'east-asia', ['Seoul', 126.98, 37.57]),
  c('LKA', '144', 'Sri Lanka', [], ['asia'], 'south-asia', ['Sri Jayawardenepura Kotte', 79.89, 6.89, ['Kotte'], ['Colombo']]),
  c('SYR', '760', 'Syria', [], ['asia'], 'middle-east', ['Damascus', 36.29, 33.51]),
  c('TWN', '158', 'Taiwan', [], ['asia'], 'east-asia', ['Taipei', 121.56, 25.03], ['disputed']),
  c('TJK', '762', 'Tajikistan', [], ['asia'], 'central-asia', ['Dushanbe', 68.79, 38.56]),
  c('THA', '764', 'Thailand', [], ['asia'], 'southeast-asia', ['Bangkok', 100.5, 13.76]),
  c('TLS', '626', 'Timor-Leste', ['East Timor'], ['asia'], 'southeast-asia', ['Dili', 125.57, -8.56]),
  c('TUR', '792', 'Turkey', ['Türkiye'], ['asia', 'europe'], 'middle-east', ['Ankara', 32.85, 39.93]),
  c('TKM', '795', 'Turkmenistan', [], ['asia'], 'central-asia', ['Ashgabat', 58.38, 37.96]),
  c('ARE', '784', 'United Arab Emirates', ['UAE', 'Emirates'], ['asia'], 'middle-east', ['Abu Dhabi', 54.37, 24.45]),
  c('UZB', '860', 'Uzbekistan', [], ['asia'], 'central-asia', ['Tashkent', 69.24, 41.3]),
  c('VNM', '704', 'Vietnam', ['Viet Nam'], ['asia'], 'southeast-asia', ['Hanoi', 105.85, 21.03]),
  c('YEM', '887', 'Yemen', [], ['asia'], 'middle-east', ['Sanaa', 44.21, 15.35]),
  c('RUS', '643', 'Russia', ['Russian Federation'], ['europe', 'asia'], 'eastern-europe', ['Moscow', 37.62, 55.76]),

  // ── Europe ────────────────────────────────────────────────────────────
  c('ALB', '008', 'Albania', [], ['europe'], 'balkans', ['Tirana', 19.82, 41.33]),
  c('AND', '020', 'Andorra', [], ['europe'], 'southern-europe', ['Andorra la Vella', 1.52, 42.51]),
  c('AUT', '040', 'Austria', [], ['europe'], 'western-europe', ['Vienna', 16.37, 48.21]),
  c('BLR', '112', 'Belarus', [], ['europe'], 'eastern-europe', ['Minsk', 27.56, 53.9]),
  c('BEL', '056', 'Belgium', [], ['europe'], 'western-europe', ['Brussels', 4.35, 50.85]),
  c('BIH', '070', 'Bosnia and Herzegovina', ['Bosnia', 'Bosnia-Herzegovina'], ['europe'], 'balkans', ['Sarajevo', 18.41, 43.86]),
  c('BGR', '100', 'Bulgaria', [], ['europe'], 'balkans', ['Sofia', 23.32, 42.7]),
  c('HRV', '191', 'Croatia', [], ['europe'], 'balkans', ['Zagreb', 15.98, 45.81]),
  c('CZE', '203', 'Czechia', ['Czech Republic'], ['europe'], 'eastern-europe', ['Prague', 14.42, 50.08]),
  c('DNK', '208', 'Denmark', [], ['europe'], 'northern-europe', ['Copenhagen', 12.57, 55.68], ['nordic']),
  c('EST', '233', 'Estonia', [], ['europe'], 'northern-europe', ['Tallinn', 24.75, 59.44], ['baltics']),
  c('FIN', '246', 'Finland', [], ['europe'], 'northern-europe', ['Helsinki', 24.94, 60.17], ['nordic']),
  c('FRA', '250', 'France', [], ['europe'], 'western-europe', ['Paris', 2.35, 48.86]),
  c('DEU', '276', 'Germany', [], ['europe'], 'western-europe', ['Berlin', 13.4, 52.52]),
  c('GRC', '300', 'Greece', [], ['europe'], 'southern-europe', ['Athens', 23.73, 37.98]),
  c('HUN', '348', 'Hungary', [], ['europe'], 'eastern-europe', ['Budapest', 19.04, 47.5]),
  c('ISL', '352', 'Iceland', [], ['europe'], 'northern-europe', ['Reykjavík', -21.94, 64.15], ['nordic']),
  c('IRL', '372', 'Ireland', ['Republic of Ireland', 'Eire'], ['europe'], 'northern-europe', ['Dublin', -6.26, 53.35]),
  c('ITA', '380', 'Italy', [], ['europe'], 'southern-europe', ['Rome', 12.5, 41.9]),
  c('XKX', 'Kosovo', 'Kosovo', [], ['europe'], 'balkans', ['Pristina', 21.17, 42.66, ['Prishtina', 'Priština']], ['disputed']),
  c('LVA', '428', 'Latvia', [], ['europe'], 'northern-europe', ['Riga', 24.11, 56.95], ['baltics']),
  c('LIE', '438', 'Liechtenstein', [], ['europe'], 'western-europe', ['Vaduz', 9.52, 47.14]),
  c('LTU', '440', 'Lithuania', [], ['europe'], 'northern-europe', ['Vilnius', 25.28, 54.69], ['baltics']),
  c('LUX', '442', 'Luxembourg', [], ['europe'], 'western-europe', ['Luxembourg', 6.13, 49.61, ['Luxembourg City']]),
  c('MLT', '470', 'Malta', [], ['europe'], 'southern-europe', ['Valletta', 14.51, 35.9]),
  c('MDA', '498', 'Moldova', [], ['europe'], 'eastern-europe', ['Chișinău', 28.86, 47.01]),
  c('MCO', '492', 'Monaco', [], ['europe'], 'western-europe', ['Monaco', 7.42, 43.74, ['Monaco-Ville']]),
  c('MNE', '499', 'Montenegro', [], ['europe'], 'balkans', ['Podgorica', 19.26, 42.44]),
  c('NLD', '528', 'Netherlands', ['Holland'], ['europe'], 'western-europe', ['Amsterdam', 4.9, 52.37, [], ['The Hague']]),
  c('MKD', '807', 'North Macedonia', ['Macedonia'], ['europe'], 'balkans', ['Skopje', 21.43, 41.99]),
  c('NOR', '578', 'Norway', [], ['europe'], 'northern-europe', ['Oslo', 10.75, 59.91], ['nordic']),
  c('POL', '616', 'Poland', [], ['europe'], 'eastern-europe', ['Warsaw', 21.01, 52.23]),
  c('PRT', '620', 'Portugal', [], ['europe'], 'southern-europe', ['Lisbon', -9.14, 38.72]),
  c('ROU', '642', 'Romania', [], ['europe'], 'eastern-europe', ['Bucharest', 26.1, 44.43]),
  c('SMR', '674', 'San Marino', [], ['europe'], 'southern-europe', ['San Marino', 12.45, 43.94]),
  c('SRB', '688', 'Serbia', [], ['europe'], 'balkans', ['Belgrade', 20.46, 44.79]),
  c('SVK', '703', 'Slovakia', [], ['europe'], 'eastern-europe', ['Bratislava', 17.11, 48.15]),
  c('SVN', '705', 'Slovenia', [], ['europe'], 'balkans', ['Ljubljana', 14.51, 46.06]),
  c('ESP', '724', 'Spain', [], ['europe'], 'southern-europe', ['Madrid', -3.7, 40.42]),
  c('SWE', '752', 'Sweden', [], ['europe'], 'northern-europe', ['Stockholm', 18.07, 59.33], ['nordic']),
  c('CHE', '756', 'Switzerland', [], ['europe'], 'western-europe', ['Bern', 7.45, 46.95, ['Berne']]),
  c('UKR', '804', 'Ukraine', [], ['europe'], 'eastern-europe', ['Kyiv', 30.52, 50.45, ['Kiev']]),
  c('GBR', '826', 'United Kingdom', ['UK', 'Great Britain', 'Britain', 'United Kingdom of Great Britain and Northern Ireland'], ['europe'], 'northern-europe', ['London', -0.13, 51.51]),
  c('VAT', '336', 'Vatican City', ['Vatican', 'Holy See'], ['europe'], 'southern-europe', ['Vatican City', 12.45, 41.9, ['Vatican']]),

  // ── North and Central America, the Caribbean ──────────────────────────
  c('CAN', '124', 'Canada', [], ['north-america'], 'northern-america', ['Ottawa', -75.7, 45.42]),
  c('USA', '840', 'United States', ['USA', 'US', 'United States of America', 'America'], ['north-america'], 'northern-america', ['Washington, D.C.', -77.04, 38.91, ['Washington', 'Washington DC']]),
  c('MEX', '484', 'Mexico', [], ['north-america'], 'central-america', ['Mexico City', -99.13, 19.43]),
  c('GTM', '320', 'Guatemala', [], ['north-america'], 'central-america', ['Guatemala City', -90.51, 14.63]),
  c('BLZ', '084', 'Belize', [], ['north-america'], 'central-america', ['Belmopan', -88.77, 17.25]),
  c('SLV', '222', 'El Salvador', [], ['north-america'], 'central-america', ['San Salvador', -89.19, 13.69]),
  c('HND', '340', 'Honduras', [], ['north-america'], 'central-america', ['Tegucigalpa', -87.21, 14.07]),
  c('NIC', '558', 'Nicaragua', [], ['north-america'], 'central-america', ['Managua', -86.25, 12.11]),
  c('CRI', '188', 'Costa Rica', [], ['north-america'], 'central-america', ['San José', -84.09, 9.93]),
  c('PAN', '591', 'Panama', [], ['north-america'], 'central-america', ['Panama City', -79.52, 8.98]),
  c('CUB', '192', 'Cuba', [], ['north-america'], 'caribbean', ['Havana', -82.37, 23.11]),
  c('JAM', '388', 'Jamaica', [], ['north-america'], 'caribbean', ['Kingston', -76.79, 18.0]),
  c('HTI', '332', 'Haiti', [], ['north-america'], 'caribbean', ['Port-au-Prince', -72.34, 18.54]),
  c('DOM', '214', 'Dominican Republic', [], ['north-america'], 'caribbean', ['Santo Domingo', -69.93, 18.49]),
  c('BHS', '044', 'The Bahamas', [], ['north-america'], 'caribbean', ['Nassau', -77.35, 25.05]),
  c('ATG', '028', 'Antigua and Barbuda', ['Antigua'], ['north-america'], 'caribbean', ["St John's", -61.85, 17.12]),
  c('DMA', '212', 'Dominica', [], ['north-america'], 'caribbean', ['Roseau', -61.39, 15.3]),
  c('LCA', '662', 'St Lucia', [], ['north-america'], 'caribbean', ['Castries', -60.99, 14.01]),
  c('VCT', '670', 'St Vincent and the Grenadines', ['St Vincent'], ['north-america'], 'caribbean', ['Kingstown', -61.23, 13.16]),
  c('GRD', '308', 'Grenada', [], ['north-america'], 'caribbean', ["St George's", -61.75, 12.06]),
  c('BRB', '052', 'Barbados', [], ['north-america'], 'caribbean', ['Bridgetown', -59.62, 13.1]),
  c('KNA', '659', 'St Kitts and Nevis', ['St Christopher and Nevis'], ['north-america'], 'caribbean', ['Basseterre', -62.72, 17.3]),
  c('TTO', '780', 'Trinidad and Tobago', ['Trinidad'], ['north-america'], 'caribbean', ['Port of Spain', -61.52, 10.66]),
  c('GRL', '304', 'Greenland', [], ['north-america'], 'northern-america', ['Nuuk', -51.72, 64.18], ['territory']),
  c('PRI', '630', 'Puerto Rico', [], ['north-america'], 'caribbean', ['San Juan', -66.11, 18.47], ['territory']),

  // ── South America ─────────────────────────────────────────────────────
  c('ARG', '032', 'Argentina', [], ['south-america'], 'south-america', ['Buenos Aires', -58.38, -34.6]),
  c('BOL', '068', 'Bolivia', [], ['south-america'], 'south-america', ['Sucre', -65.26, -19.03, [], ['La Paz']]),
  c('BRA', '076', 'Brazil', [], ['south-america'], 'south-america', ['Brasília', -47.88, -15.79]),
  c('CHL', '152', 'Chile', [], ['south-america'], 'south-america', ['Santiago', -70.67, -33.45]),
  c('COL', '170', 'Colombia', [], ['south-america'], 'south-america', ['Bogotá', -74.07, 4.71]),
  c('ECU', '218', 'Ecuador', [], ['south-america'], 'south-america', ['Quito', -78.47, -0.18]),
  c('GUY', '328', 'Guyana', [], ['south-america'], 'south-america', ['Georgetown', -58.16, 6.8]),
  c('PRY', '600', 'Paraguay', [], ['south-america'], 'south-america', ['Asunción', -57.58, -25.26]),
  c('PER', '604', 'Peru', [], ['south-america'], 'south-america', ['Lima', -77.04, -12.05]),
  c('SUR', '740', 'Suriname', ['Surinam'], ['south-america'], 'south-america', ['Paramaribo', -55.2, 5.85]),
  c('URY', '858', 'Uruguay', [], ['south-america'], 'south-america', ['Montevideo', -56.16, -34.9]),
  c('VEN', '862', 'Venezuela', [], ['south-america'], 'south-america', ['Caracas', -66.9, 10.49]),
  // Part of France in the atlas; the build cuts it out by location.
  c('GUF', 'France:guiana', 'French Guiana', [], ['south-america'], 'south-america', ['Cayenne', -52.33, 4.94], ['territory']),
  c('FLK', '238', 'Falkland Islands', ['Falklands', 'Malvinas', 'Islas Malvinas'], ['south-america'], 'south-america', ['Stanley', -57.85, -51.69], ['territory']),

  // ── Oceania ───────────────────────────────────────────────────────────
  c('AUS', '036', 'Australia', [], ['oceania'], 'australasia', ['Canberra', 149.13, -35.28]),
  c('NZL', '554', 'New Zealand', ['Aotearoa'], ['oceania'], 'australasia', ['Wellington', 174.78, -41.29]),
  c('FJI', '242', 'Fiji', [], ['oceania'], 'melanesia', ['Suva', 178.44, -18.14]),
  c('PNG', '598', 'Papua New Guinea', ['PNG'], ['oceania'], 'melanesia', ['Port Moresby', 147.18, -9.44]),
  c('SLB', '090', 'Solomon Islands', ['Solomons'], ['oceania'], 'melanesia', ['Honiara', 159.96, -9.43]),
  c('VUT', '548', 'Vanuatu', [], ['oceania'], 'melanesia', ['Port Vila', 168.32, -17.73]),
  c('KIR', '296', 'Kiribati', [], ['oceania'], 'micronesia', ['South Tarawa', 173.0, 1.33, ['Tarawa']]),
  c('MHL', '584', 'Marshall Islands', [], ['oceania'], 'micronesia', ['Majuro', 171.38, 7.09]),
  c('FSM', '583', 'Micronesia', ['Federated States of Micronesia', 'FSM'], ['oceania'], 'micronesia', ['Palikir', 158.16, 6.92]),
  // Nauru has no official capital. Yaren is where the government sits.
  c('NRU', '520', 'Nauru', [], ['oceania'], 'micronesia', ['Yaren', 166.92, -0.55]),
  c('PLW', '585', 'Palau', [], ['oceania'], 'micronesia', ['Ngerulmud', 134.62, 7.5]),
  c('WSM', '882', 'Samoa', [], ['oceania'], 'polynesia', ['Apia', -171.76, -13.83]),
  c('TON', '776', 'Tonga', [], ['oceania'], 'polynesia', ["Nuku'alofa", -175.2, -21.14, ['Nukualofa']]),
  // Too small for the 1:50m atlas to draw at all. Played as a dot.
  c('TUV', null, 'Tuvalu', [], ['oceania'], 'polynesia', ['Funafuti', 179.19, -8.52]),
  c('NCL', '540', 'New Caledonia', [], ['oceania'], 'melanesia', ['Nouméa', 166.46, -22.27], ['territory']),
];

/** Where a place the atlas does not draw is played as a dot. */
export const POINTS = { TUV: [179.19, -8.52] };

/**
 * Atlas features folded into another before drawing. See Somalia and Cyprus.
 * Anything not named here and not claimed by a row above is drawn in grey.
 */
export const MERGE = { SOM: ['Somaliland'], CYP: ['N. Cyprus'] };

/**
 * Countries whose atlas feature includes overseas land drawn elsewhere.
 * Only polygons whose rough centre falls in `keep` stay with the country.
 * French Guiana is then claimed by GUF; the rest go grey.
 */
export const KEEP_ONLY = {
  FRA: { lon: [-6, 10], lat: [41, 52] },
  NLD: { lon: [3, 8], lat: [50, 54] },
};
export const CUT_OUT = { 'France:guiana': { from: '250', lon: [-55, -51], lat: [2, 6] } };
