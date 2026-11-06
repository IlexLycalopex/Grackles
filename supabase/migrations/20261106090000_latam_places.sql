-- LatAm: places, themes, and what to read or watch about each.
--
-- Learning-led, so no trips yet. Three ideas carry it:
--
-- 1. A place is a tag. Bariloche's slug is `bariloche`, and anything tagged
--    bariloche (a phone entry, a podcast episode in JPOD, a book in the
--    Reading List) is about Bariloche without being filed there. The place
--    page reads those projects by tag, as the overview already does by the
--    focus tag. Nothing is copied.
--
-- 2. A theme is a tag too (history, gaucho, wine, fishing), with a short list
--    of things worth reading, watching or listening to.
--
-- 3. A deep dive on a place is AI-assisted (`latam.research`), and follows the
--    rule the reading lookup set: the app decides facts, the model supplies
--    prose. The model writes a briefing and proposes books, films and articles;
--    the app keeps only the books OpenLibrary finds and the films and articles
--    Wikipedia has a page for. What survives is a proposal; keeping one makes
--    it a learning item.
--
-- The starter set (`lx_seed_argentina`) is about sixty places and nine themes,
-- loaded into a project by an editor on the Places page. It is data in a
-- function rather than rows in a migration so it works for any LatAm project
-- and carries no project's id.

create table public.lx_places (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug         text not null,
  name         text not null,
  kind         text not null,
  -- The region's slug, '' for a region itself. A string rather than a key so
  -- the starter set can name a region it has not inserted yet.
  region       text not null default '',
  province     text not null default '',
  lat          numeric(8,5),
  lng          numeric(8,5),
  summary      text not null default '',
  status       text not null default '',
  notes        text not null default '',
  source_url   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  unique (workspace_id, slug),
  constraint lx_places_slug   check (app.jp_tags_ok(array[slug])),
  constraint lx_places_kind   check (kind in ('region', 'city', 'town', 'park', 'river', 'lake', 'site', 'route')),
  constraint lx_places_status check (status in ('', 'learning', 'want', 'been')),
  constraint lx_places_name   check (char_length(btrim(name)) between 1 and 120),
  constraint lx_places_text   check (char_length(summary) <= 800 and char_length(notes) <= 4000),
  constraint lx_places_lat    check (lat is null or lat between -90 and 90),
  constraint lx_places_lng    check (lng is null or lng between -180 and 180),
  constraint lx_places_url    check (source_url = '' or source_url ~ '^https?://')
);

create index lx_places_region_idx on public.lx_places (workspace_id, region);

create trigger touch_lx_places before update on public.lx_places
  for each row execute function public.touch_updated_at();

create table public.lx_themes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  slug         text not null,
  name         text not null,
  summary      text not null default '',
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),

  unique (workspace_id, slug),
  constraint lx_themes_slug check (app.jp_tags_ok(array[slug])),
  constraint lx_themes_name check (char_length(btrim(name)) between 1 and 80),
  constraint lx_themes_text check (char_length(summary) <= 800)
);

-- Something to read, watch or listen to, on a theme or a place.
create table public.lx_items (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  theme_id     uuid references public.lx_themes(id) on delete cascade,
  place_id     uuid references public.lx_places(id) on delete cascade,
  kind         text not null,
  title        text not null,
  creator      text not null default '',
  url          text not null default '',
  why          text not null default '',
  done         boolean not null default false,
  source       text not null default 'manual',
  created_at   timestamptz not null default now(),

  constraint lx_items_owner  check ((theme_id is null) <> (place_id is null)),
  constraint lx_items_kind   check (kind in ('book', 'film', 'podcast', 'article', 'other')),
  constraint lx_items_source check (source in ('seed', 'research', 'manual')),
  constraint lx_items_title  check (char_length(btrim(title)) between 1 and 300),
  constraint lx_items_text   check (char_length(creator) <= 200 and char_length(why) <= 600),
  constraint lx_items_url    check (url = '' or url ~ '^https?://')
);

create index lx_items_theme_idx on public.lx_items (theme_id) where theme_id is not null;
create index lx_items_place_idx on public.lx_items (place_id) where place_id is not null;
-- One copy of a thing per place or theme, however many deep dives propose it.
create unique index lx_items_once_idx
  on public.lx_items (coalesce(theme_id, place_id), lower(title), kind);

-- A deep dive, as it came back and after checking. Kept, not overwritten, so
-- a second dive on the same place does not lose the first.
create table public.lx_research (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  place_id     uuid not null references public.lx_places(id) on delete cascade,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  -- Prose sections and local words: the model's, shown as such.
  brief        jsonb not null default '{}',
  -- [{kind, title, creator, url, why}], every one checked against a catalogue.
  suggestions  jsonb not null default '[]',
  -- How many proposals were dropped for failing that check.
  dropped      integer not null default 0,
  ai_call_id   uuid
);

create index lx_research_place_idx on public.lx_research (place_id, created_at desc);

-- ── The starter set ─────────────────────────────────────────────────
create function public.lx_seed_argentina(p_workspace uuid)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  places jsonb := $places$[
  ["the-pampas","Buenos Aires and the Pampas","region","","",-35.5,-60.5,"The capital and the flat grasslands around it: cattle, wheat and the gaucho's original country."],
  ["litoral","The Litoral","region","","",-28.5,-58.5,"The north-east between the Paraná and Uruguay rivers: wetlands, Guaraní culture, Iguazú."],
  ["noroeste","The North-West","region","","",-24.5,-65.8,"Andean Argentina: colonial Salta, Quechua and Aymara culture, high valleys and salt flats."],
  ["cuyo","Cuyo","region","","",-32.5,-68.8,"Mendoza, San Juan and San Luis: irrigated desert, most of the country's wine, Aconcagua."],
  ["centro","Córdoba and the Centre","region","","",-31.4,-64.2,"The sierras of Córdoba: Jesuit estancias, the oldest university, the second city."],
  ["patagonia","Patagonia","region","","",-44.0,-69.0,"Everything south of the Colorado river: lakes and Andes in the west, steppe and coast in the east."],
  ["tierra-del-fuego","Tierra del Fuego","region","","",-54.3,-67.8,"The Argentine half of the archipelago at the tip of the continent."],

  ["buenos-aires","Buenos Aires","city","the-pampas","Ciudad de Buenos Aires",-34.6037,-58.3816,"The capital and port: tango, cafés, barrios, and the porteño Spanish you hear on every podcast."],
  ["san-antonio-de-areco","San Antonio de Areco","town","the-pampas","Buenos Aires",-34.2447,-59.4719,"Gaucho heritage town; the Fiesta de la Tradición each November; the setting of Don Segundo Sombra."],
  ["la-plata","La Plata","city","the-pampas","Buenos Aires",-34.9205,-57.9536,"Planned provincial capital of 1882, with a celebrated natural history museum."],
  ["tigre","Tigre and the Delta","town","the-pampas","Buenos Aires",-34.4264,-58.5796,"Gateway to the islands and channels of the Paraná Delta."],
  ["mar-del-plata","Mar del Plata","city","the-pampas","Buenos Aires",-38.0055,-57.5426,"The great Atlantic resort city of the porteño summer."],

  ["iguazu","Iguazú Falls","park","litoral","Misiones",-25.6953,-54.4367,"Some 275 falls on the Brazilian border, with the Garganta del Diablo; a national park and UNESCO site."],
  ["san-ignacio-mini","San Ignacio Miní","site","litoral","Misiones",-27.2556,-55.5328,"Ruins of a Jesuit-Guaraní mission; UNESCO-listed with its neighbours."],
  ["ibera","Esteros del Iberá","park","litoral","Corrientes",-28.5,-57.2,"Vast wetlands with capybara, caiman and marsh deer; a rewilding project has brought back the jaguar."],
  ["rosario","Rosario","city","litoral","Santa Fe",-32.9442,-60.6505,"River port and third city; the Flag Monument; birthplace of Che Guevara and Lionel Messi."],
  ["parana-river","Río Paraná","river","litoral","",-27.47,-58.83,"South America's second-longest river; dorado fishing in the Litoral."],

  ["salta","Salta","city","noroeste","Salta",-24.7821,-65.4232,"The best-kept colonial city in the north-west, and the gateway to it."],
  ["quebrada-de-humahuaca","Quebrada de Humahuaca","site","noroeste","Jujuy",-23.2,-65.35,"UNESCO-listed valley on an old Inca route; Purmamarca's Hill of Seven Colours."],
  ["cafayate","Cafayate","town","noroeste","Salta",-26.0733,-65.9761,"High-altitude Torrontés wine in the Calchaquí Valleys."],
  ["salinas-grandes","Salinas Grandes","site","noroeste","Jujuy",-23.6,-65.9,"Salt flats on the puna at about 3,400 metres."],
  ["tucuman","San Miguel de Tucumán","city","noroeste","Tucumán",-26.8083,-65.2176,"Where independence was declared on 9 July 1816."],

  ["mendoza","Mendoza","city","cuyo","Mendoza",-32.8895,-68.8458,"Wine capital at the foot of the Andes, watered by colonial irrigation channels."],
  ["valle-de-uco","Valle de Uco","site","cuyo","Mendoza",-33.6,-69.2,"High vineyards beneath the Andes; much of the best Malbec."],
  ["aconcagua","Aconcagua","park","cuyo","Mendoza",-32.6532,-70.0109,"At 6,961 metres, the highest mountain outside Asia."],
  ["ischigualasto","Ischigualasto and Talampaya","park","cuyo","San Juan / La Rioja",-29.9,-67.9,"The Valley of the Moon and Talampaya's red canyons; Triassic fossils, UNESCO-listed."],

  ["cordoba","Córdoba","city","centro","Córdoba",-31.4201,-64.1888,"Second city; the Jesuit Block (UNESCO) and a university founded in 1613."],
  ["alta-gracia","Alta Gracia","town","centro","Córdoba",-31.6529,-64.4283,"A Jesuit estancia, and the house where Che Guevara grew up."],

  ["bariloche","Bariloche","city","patagonia","Río Negro",-41.1335,-71.3103,"San Carlos de Bariloche on Lago Nahuel Huapi: the base for the northern lakes."],
  ["nahuel-huapi","Nahuel Huapi National Park","park","patagonia","Neuquén / Río Negro",-40.95,-71.5,"Argentina's first national park, from 1934: lakes, Andean forest and mountains."],
  ["villa-la-angostura","Villa La Angostura","town","patagonia","Neuquén",-40.7616,-71.6463,"Lakeside village on Nahuel Huapi; the Arrayanes forest."],
  ["el-bolson","El Bolsón","town","patagonia","Río Negro",-41.9645,-71.5355,"Valley town known for its craft fair, hops and berries."],
  ["san-martin-de-los-andes","San Martín de los Andes","town","patagonia","Neuquén",-40.1572,-71.3534,"On Lago Lácar; the base for Lanín and the rivers around Junín."],
  ["junin-de-los-andes","Junín de los Andes","town","patagonia","Neuquén",-39.9504,-71.0694,"Calls itself the trout capital; the Chimehuín, Malleo and Aluminé are close."],
  ["lanin","Lanín National Park","park","patagonia","Neuquén",-39.637,-71.502,"Volcán Lanín, araucaria forests and Mapuche communities."],
  ["chimehuin","Río Chimehuín","river","patagonia","Neuquén",-39.9,-71.1,"Classic trout river out of Lago Huechulafquen; the Boca is known for large browns."],
  ["malleo","Río Malleo","river","patagonia","Neuquén",-39.75,-71.1,"Dry-fly river through Mapuche land and araucaria country."],
  ["limay","Río Limay","river","patagonia","Neuquén / Río Negro",-40.6,-70.6,"Big river out of Nahuel Huapi, with migratory brown trout."],
  ["esquel","Esquel","town","patagonia","Chubut",-42.9116,-71.3197,"Home of La Trochita, the narrow-gauge steam train; the base for Los Alerces."],
  ["los-alerces","Los Alerces National Park","park","patagonia","Chubut",-42.8,-71.88,"Ancient alerce trees, lakes and trout rivers; UNESCO-listed."],
  ["trevelin","Trevelin","town","patagonia","Chubut",-43.0858,-71.4655,"A Welsh-founded town in the Andes; tea houses and the old mill."],
  ["gaiman","Gaiman","town","patagonia","Chubut",-43.2897,-65.4923,"Welsh tea houses in the lower Chubut valley."],
  ["trelew","Trelew","city","patagonia","Chubut",-43.2532,-65.3051,"Welsh valley town with a major dinosaur museum."],
  ["puerto-madryn","Puerto Madryn","city","patagonia","Chubut",-42.7692,-65.0385,"Where the Welsh settlers landed in 1865; whale-watching on the gulf."],
  ["peninsula-valdes","Península Valdés","site","patagonia","Chubut",-42.5,-64.0,"UNESCO-listed: southern right whales, elephant seals, and orcas hunting sea lions on the beach."],
  ["punta-tombo","Punta Tombo","site","patagonia","Chubut",-44.05,-65.22,"One of the largest Magellanic penguin colonies; the birds are there roughly September to April."],
  ["cueva-de-las-manos","Cueva de las Manos","site","patagonia","Santa Cruz",-47.15,-70.67,"Rock art with hand stencils some 9,000 years old; UNESCO-listed."],
  ["lago-strobel","Lago Strobel","lake","patagonia","Santa Cruz",-48.45,-71.25,"Jurassic Lake: remote plateau lake with exceptionally large rainbow trout."],
  ["el-chalten","El Chaltén","town","patagonia","Santa Cruz",-49.3315,-72.8863,"Trekking village beneath Fitz Roy and Cerro Torre."],
  ["los-glaciares","Los Glaciares National Park","park","patagonia","Santa Cruz",-49.8,-73.2,"The Southern Patagonian Ice Field's eastern edge, Fitz Roy and the glaciers; UNESCO-listed."],
  ["el-calafate","El Calafate","town","patagonia","Santa Cruz",-50.3379,-72.2648,"On Lago Argentino; the base for the Perito Moreno glacier."],
  ["perito-moreno","Perito Moreno Glacier","site","patagonia","Santa Cruz",-50.4967,-73.1377,"A glacier that is still advancing; its ice front calves into Lago Argentino."],
  ["puerto-san-julian","Puerto San Julián","town","patagonia","Santa Cruz",-49.3069,-67.729,"Where Magellan wintered in 1520 and Drake in 1578; Darwin came ashore here."],
  ["rio-gallegos","Río Gallegos","city","patagonia","Santa Cruz",-51.623,-69.2168,"Santa Cruz's capital, on a river with sea-run brown trout."],
  ["ruta-40","Ruta 40","route","patagonia","",-45.0,-70.8,"National Route 40, running some 5,000 km down the length of the Andes."],

  ["ushuaia","Ushuaia","city","tierra-del-fuego","Tierra del Fuego",-54.8019,-68.303,"The southernmost city, on the Beagle Channel; an old penal colony and the port for Antarctica."],
  ["tierra-del-fuego-np","Tierra del Fuego National Park","park","tierra-del-fuego","Tierra del Fuego",-54.83,-68.55,"Forest, peat bog and coast where Ruta 3 ends."],
  ["beagle-channel","Beagle Channel","site","tierra-del-fuego","Tierra del Fuego",-54.87,-68.1,"Named after Darwin's ship; sea lions and the Les Éclaireurs lighthouse."],
  ["harberton","Estancia Harberton","site","tierra-del-fuego","Tierra del Fuego",-54.873,-67.333,"Founded by Thomas Bridges in 1886; the world of Uttermost Part of the Earth."],
  ["rio-grande","Río Grande","river","tierra-del-fuego","Tierra del Fuego",-53.8,-67.9,"Famous for sea-run brown trout, best from January to April."],
  ["malvinas","Falkland Islands / Islas Malvinas","site","tierra-del-fuego","",-51.75,-59.0,"A British Overseas Territory claimed by Argentina; the 1982 war still shapes national politics."]
  ]$places$;
  themes jsonb := $themes$[
  ["history","History","From the Spanish colony and independence to Rosas, the Conquest of the Desert, Perón and the dictatorship.",
    [["book","A Brief History of Argentina","Jonathan C. Brown",""],
     ["book","Facundo","Domingo F. Sarmiento","Civilisation against barbarism: the founding argument about the country."],
     ["book","The Voyage of the Beagle","Charles Darwin","Patagonia and Tierra del Fuego in the 1830s."],
     ["film","Argentina, 1985","Santiago Mitre","The trial of the juntas."]]],
  ["politics","Politics and the economy","Peronism, crises and the present: how the country argues with itself.",
    [["podcast","The Argentina Brief","",""],
     ["book","The Return of Eva Perón","V. S. Naipaul",""],
     ["book","Santa Evita","Tomás Eloy Martínez",""],
     ["book","The Real Odessa","Uki Goñi","How Nazi war criminals reached Argentina."]]],
  ["gaucho","The gaucho and the pampa","The horseman of the plains, in poetry, novels and the tradition festivals.",
    [["book","Martín Fierro","José Hernández","The national epic poem."],
     ["book","Don Segundo Sombra","Ricardo Güiraldes",""],
     ["book","Far Away and Long Ago","W. H. Hudson","A childhood on the pampas."]]],
  ["welsh-patagonia","Welsh Patagonia","Y Wladfa: the Welsh colony of 1865 in the Chubut valley and the Andes.",
    [["article","Y Wladfa","Wikipedia","https://en.wikipedia.org/wiki/Y_Wladfa"],
     ["book","In Patagonia","Bruce Chatwin",""]]],
  ["travel-writing","Travel writing","Patagonia as outsiders have written it.",
    [["book","In Patagonia","Bruce Chatwin",""],
     ["book","Uttermost Part of the Earth","E. Lucas Bridges",""],
     ["book","The Old Patagonian Express","Paul Theroux",""],
     ["book","Idle Days in Patagonia","W. H. Hudson",""],
     ["book","The Motorcycle Diaries","Ernesto Che Guevara",""]]],
  ["literature","Literature","Argentine fiction from Borges to the new gothic.",
    [["book","Ficciones","Jorge Luis Borges",""],
     ["book","Rayuela","Julio Cortázar",""],
     ["book","El túnel","Ernesto Sabato",""],
     ["book","Kiss of the Spider Woman","Manuel Puig",""],
     ["book","Our Share of Night","Mariana Enriquez",""],
     ["book","Fever Dream","Samanta Schweblin",""]]],
  ["cinema","Cinema","Films to hear the Spanish and see the country.",
    [["film","El secreto de sus ojos","Juan José Campanella",""],
     ["film","Nueve reinas","Fabián Bielinsky",""],
     ["film","Relatos salvajes","Damián Szifron",""],
     ["film","La historia oficial","Luis Puenzo",""],
     ["film","Zama","Lucrecia Martel",""]]],
  ["wine","Wine","Malbec, Torrontés and high-altitude viticulture.",
    [["book","Vino Argentino","Laura Catena",""],
     ["article","Malbec","Wikipedia","https://en.wikipedia.org/wiki/Malbec"]]],
  ["fishing","Fly fishing","Patagonian trout: rivers, seasons and licences. Each province sets its own dates and licence.",
    [["article","Where to fish in Patagonia: seasons and licences","Interpatagonia","https://www.interpatagonia.com/pesca/where-to-fish.html"]]],
  ["spanish","Argentine Spanish","Voseo, the sh sound for ll and y, and Lunfardo slang.",
    [["article","Voseo","Wikipedia","https://en.wikipedia.org/wiki/Voseo"],
     ["article","Lunfardo","Wikipedia","https://en.wikipedia.org/wiki/Lunfardo"]]]
  ]$themes$;
  p jsonb;
  t jsonb;
  i jsonb;
  v_theme uuid;
  n_places integer := 0;
  n_themes integer := 0;
  n_rows integer;
begin
  if auth.uid() is not null and not app.can_write(p_workspace) then
    raise exception 'only an editor can load the starter set' using errcode = 'GRK50';
  end if;
  if not exists (select 1 from public.workspaces where id = p_workspace and app = 'latam') then
    raise exception 'not a LatAm project' using errcode = 'GRK51';
  end if;

  for p in select * from jsonb_array_elements(places) loop
    insert into public.lx_places (workspace_id, slug, name, kind, region, province, lat, lng, summary, status)
    values (p_workspace, p->>0, p->>1, p->>2, p->>3, p->>4, (p->>5)::numeric, (p->>6)::numeric, p->>7, 'learning')
    on conflict (workspace_id, slug) do nothing;
    get diagnostics n_rows = row_count;
    n_places := n_places + n_rows;
  end loop;

  for t in select * from jsonb_array_elements(themes) loop
    insert into public.lx_themes (workspace_id, slug, name, summary, sort)
    values (p_workspace, t->>0, t->>1, t->>2, n_themes)
    on conflict (workspace_id, slug) do nothing
    returning id into v_theme;
    if v_theme is not null then
      n_themes := n_themes + 1;
      for i in select * from jsonb_array_elements(t->3) loop
        insert into public.lx_items (workspace_id, theme_id, kind, title, creator, url, why, source)
        values (p_workspace, v_theme, i->>0, i->>1, i->>2,
                case when i->>3 ~ '^https?://' then i->>3 else '' end,
                case when i->>3 ~ '^https?://' then '' else i->>3 end, 'seed')
        on conflict do nothing;
      end loop;
    end if;
    v_theme := null;
  end loop;

  return jsonb_build_object('places', n_places, 'themes', n_themes);
end
$$;

-- ── The AI feature ──────────────────────────────────────────────────
-- One call per deep dive. Only a place's name, kind and province are sent:
-- public geography, not anybody's records, hence sends_records = false.
insert into public.ai_features
  (key, app, name, max_tokens, min_role, provider, model,
   default_max_usd, default_max_calls, prompt_allowance_tokens, sends_records)
values
  ('latam.research', 'latam', 'Research a place', 3500, 'editor', 'minimax', 'minimax-m3',
   0.050000, 1, 1500, false)
on conflict (key) do nothing;

insert into public.ai_workspace_features (workspace_id, feature, enabled)
select w.id, 'latam.research', true from public.workspaces w where w.app = 'latam'
on conflict (workspace_id, feature) do nothing;

-- ── Privileges ──────────────────────────────────────────────────────
revoke all on public.lx_places, public.lx_themes, public.lx_items, public.lx_research from anon, authenticated;
grant select on public.lx_places, public.lx_themes, public.lx_items, public.lx_research to anon, authenticated;
grant insert, delete on public.lx_places, public.lx_themes, public.lx_items to authenticated;
grant update (name, kind, region, province, lat, lng, summary, status, notes, source_url) on public.lx_places to authenticated;
grant update (name, summary, sort) on public.lx_themes to authenticated;
grant update (title, creator, url, why, done) on public.lx_items to authenticated;
grant insert, delete on public.lx_research to authenticated;
grant select, insert, update, delete on public.lx_places, public.lx_themes, public.lx_items, public.lx_research to service_role;

revoke all on function public.lx_seed_argentina(uuid) from public, anon, authenticated;
grant execute on function public.lx_seed_argentina(uuid) to authenticated, service_role;

alter table public.lx_places   enable row level security;
alter table public.lx_themes   enable row level security;
alter table public.lx_items    enable row level security;
alter table public.lx_research enable row level security;

create policy lx_places_read   on public.lx_places for select using (app.can_read(workspace_id));
create policy lx_places_insert on public.lx_places for insert with check (app.can_write(workspace_id));
create policy lx_places_update on public.lx_places for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lx_places_delete on public.lx_places for delete using (app.can_write(workspace_id));

create policy lx_themes_read   on public.lx_themes for select using (app.can_read(workspace_id));
create policy lx_themes_insert on public.lx_themes for insert with check (app.can_write(workspace_id));
create policy lx_themes_update on public.lx_themes for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lx_themes_delete on public.lx_themes for delete using (app.can_write(workspace_id));

-- An item belongs to the project its theme or place belongs to, not merely to
-- the project it claims.
create policy lx_items_read   on public.lx_items for select using (app.can_read(workspace_id));
create policy lx_items_insert on public.lx_items for insert with check (
  app.can_write(workspace_id)
  and (theme_id is null or exists (select 1 from public.lx_themes t where t.id = theme_id and t.workspace_id = lx_items.workspace_id))
  and (place_id is null or exists (select 1 from public.lx_places p where p.id = place_id and p.workspace_id = lx_items.workspace_id)));
create policy lx_items_update on public.lx_items for update using (app.can_write(workspace_id)) with check (app.can_write(workspace_id));
create policy lx_items_delete on public.lx_items for delete using (app.can_write(workspace_id));

create policy lx_research_read   on public.lx_research for select using (app.can_read(workspace_id));
create policy lx_research_insert on public.lx_research for insert with check (
  app.can_write(workspace_id)
  and created_by = auth.uid()
  and exists (select 1 from public.lx_places p where p.id = place_id and p.workspace_id = lx_research.workspace_id));
create policy lx_research_delete on public.lx_research for delete using (app.can_write(workspace_id));
