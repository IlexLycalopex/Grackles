import { FormValues, invalid, valid, type Parsed } from '../forms';
import {
  CALLER_TYPES, CONFIDENCES, LOCATION_CONFIDENCE, PHENOMENON_STATUSES,
  broadcastSlug, type CallerType, type Confidence, type LocationConfidence,
  type PhenomenonStatus,
} from '../wbpr';

/**
 * Reading a broadcast, a block and a phenomenon out of a form.
 *
 * Each rule below mirrors a constraint on the table, in the order it reads
 * there, so a rejected save comes back as a sentence rather than a SQLSTATE.
 * The database still checks every one of them — this is the wording, not the
 * guarantee.
 */

export interface BroadcastValues {
  session: number;
  slug: string;
  station: string;
  call_sign: string;
  location: string;
  lat: number | null;
  lon: number | null;
  date: string;
  start_time: string;
  end_time: string;
  duration_minutes: number | null;
  atmospheric_conditions: string;
  veil_status: string;
  veil_intensity: number | null;
  dawn_colour: string;
  veil_at_close: string;
  personal_notes: string;
  tags: string[];
}

export function readBroadcast(form: FormData): Parsed<BroadcastValues> {
  const f = new FormValues(form);

  const session = f.int('session');
  const date = f.date('date');
  const intensity = f.int('veil_intensity');

  if (session === null || session < 1) {
    return invalid('A broadcast needs a session number, and it starts at 1.');
  }
  if (!date) {
    return invalid('A broadcast needs the date it went out.');
  }
  if (intensity !== null && (intensity < 1 || intensity > 10)) {
    return invalid('Veil intensity runs from 1 to 10.');
  }

  const lat = f.dec('lat');
  const lon = f.dec('lon');
  // Half a coordinate puts a pin in the Atlantic. Either both or neither.
  if ((lat === null) !== (lon === null)) {
    return invalid('A location needs both a latitude and a longitude, or neither.');
  }

  return valid({
    session,
    // Derived, never typed: the slug is the session number and the archive
    // links to it. Letting it be edited would break every link to a night.
    slug: broadcastSlug(session),
    station: f.str('station') || 'WBPR',
    call_sign: f.str('call_sign') || 'Oso Sur',
    location: f.str('location'),
    lat,
    lon,
    date,
    start_time: f.str('start_time'),
    end_time: f.str('end_time'),
    duration_minutes: f.int('duration_minutes'),
    atmospheric_conditions: f.str('atmospheric_conditions'),
    veil_status: f.str('veil_status') || 'Stable',
    veil_intensity: intensity,
    dawn_colour: f.str('dawn_colour'),
    veil_at_close: f.str('veil_at_close'),
    personal_notes: f.str('personal_notes'),
    tags: f.list('tags'),
  });
}

export interface BlockValues {
  time_label: string;
  caller_type: CallerType;
  caller_card: string;
  caller_card_meaning: string;
  caller_location: string;
  caller_lat: number | null;
  caller_lon: number | null;
  caller_location_confidence: LocationConfidence;
  phenomenon_ref: string;
  notes: string;
}

export interface PromptValues { position: number; card: string; tone: string }
export interface TrackValues {
  position: number; title: string; artist: string; url: string; source: string; notes: string;
}

export interface BlockSubmission {
  block: BlockValues;
  prompts: PromptValues[];
  tracks: TrackValues[];
}

/**
 * A block, its three cards and its playlist, in one submission.
 *
 * The repeated fields arrive as parallel arrays — every `prompt_card` in
 * document order, every `prompt_tone` in document order — which is what a form
 * gives you for free and needs no client-side scripting to assemble. Rows that
 * came back entirely blank are dropped rather than saved as empty records, so
 * deleting a track is clearing its title.
 */
export function readBlock(form: FormData): Parsed<BlockSubmission> {
  const f = new FormValues(form);

  const caller_type = f.choice('caller_type', CALLER_TYPES, 'none');
  const noCaller = caller_type === 'none';

  const lat = f.dec('caller_lat');
  const lon = f.dec('caller_lon');
  if ((lat === null) !== (lon === null)) {
    return invalid("A caller's location needs both a latitude and a longitude, or neither.");
  }
  if (noCaller && (lat !== null || lon !== null)) {
    return invalid('This block has no caller, so it cannot have somewhere they called from.');
  }

  const cards = form.getAll('prompt_card').map(v => String(v).trim());
  const tones = form.getAll('prompt_tone').map(v => String(v).trim());
  const prompts: PromptValues[] = [];
  cards.forEach((card, i) => {
    if (card) prompts.push({ position: prompts.length + 1, card, tone: tones[i] ?? '' });
  });

  const titles = form.getAll('track_title').map(v => String(v).trim());
  const artists = form.getAll('track_artist').map(v => String(v).trim());
  const urls = form.getAll('track_url').map(v => String(v).trim());
  const sources = form.getAll('track_source').map(v => String(v).trim());

  const tracks: TrackValues[] = [];
  for (let i = 0; i < titles.length; i++) {
    if (!titles[i]) continue;
    const url = urls[i] ?? '';
    if (url && !/^https?:\/\//i.test(url)) {
      return invalid(`The link on "${titles[i]}" has to start http:// or https://.`);
    }
    tracks.push({
      position: tracks.length + 1,
      title: titles[i],
      artist: artists[i] ?? '',
      url,
      source: sources[i] ?? '',
      notes: '',
    });
  }

  return valid({
    block: {
      time_label: f.str('time_label'),
      caller_type,
      // wbpr_blocks_caller_fields refuses these on a block with no caller.
      // Clearing them here means changing the roll to "no caller" tidies up
      // after itself instead of failing with a constraint violation.
      caller_card: noCaller ? '' : f.str('caller_card'),
      caller_card_meaning: noCaller ? '' : f.str('caller_card_meaning'),
      caller_location: noCaller ? '' : f.str('caller_location'),
      caller_lat: lat,
      caller_lon: lon,
      caller_location_confidence: f.choice(
        'caller_location_confidence', LOCATION_CONFIDENCE, 'unknown'
      ),
      phenomenon_ref: f.str('phenomenon_ref'),
      notes: f.str('notes'),
    },
    prompts,
    tracks,
  });
}

export interface PhenomenonValues {
  key: string;
  name: string;
  status: PhenomenonStatus;
  confidence: Confidence;
  locations: string[];
  lat: number | null;
  lon: number | null;
  notes: string;
  tags: string[];
}

export function readPhenomenon(form: FormData): Parsed<PhenomenonValues> {
  const f = new FormValues(form);

  const name = f.str('name');
  if (!name) return invalid('A phenomenon needs a name.');

  // The key is what joins tonight's sighting to every other one, so it is
  // derived from the name rather than typed — two spellings of the same thing
  // are two phenomena, and nothing would ever tell you.
  const key = f.str('key') || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z0-9-]+$/.test(key)) {
    return invalid('That name does not reduce to a usable key — letters or numbers, please.');
  }

  const lat = f.dec('lat');
  const lon = f.dec('lon');
  if ((lat === null) !== (lon === null)) {
    return invalid('A location needs both a latitude and a longitude, or neither.');
  }

  return valid({
    key,
    name,
    status: f.choice('status', PHENOMENON_STATUSES, 'Active'),
    confidence: f.choice('confidence', CONFIDENCES, 'Unconfirmed'),
    locations: f.list('locations'),
    lat,
    lon,
    notes: f.str('notes'),
    tags: f.list('tags'),
  });
}
