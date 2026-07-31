import { FormValues, invalid, valid, type Parsed } from '../forms';
import { slugify } from '../slug';

export interface ContributorValues {
  slug: string;
  name: string;
  color: string;
  sort_order: number;
}

/**
 * Someone who picks albums.
 *
 * `user_id` is not on the form on purpose. A contributor exists so picks can be
 * attributed, which has to work before that person has an account — Chris was a
 * contributor with picks scheduled for 2027 long before he could sign in.
 * Linking a contributor to a real account is a separate step, done from the
 * workspace settings page where the member roster already lives.
 */
export function readContributor(form: FormData): Parsed<ContributorValues> {
  const f = new FormValues(form);

  const name = f.str('name');
  if (!name) return invalid('Give them a name.');

  const slug = slugify(f.str('slug') || name);
  if (!slug) return invalid('That name needs at least one letter or number for its URL.');

  const color = f.str('color');
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
    return invalid('Pick a colour.');
  }

  return valid({ slug, name, color, sort_order: f.int('sort_order') ?? 0 });
}
