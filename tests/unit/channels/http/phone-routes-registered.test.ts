import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A /phone route that is not registered does not 404: the console's catch-all answers 200 with index.html, so the phone
// gets HTML instead of JSON or 204 and nothing complains. `/phone/brief` was lost this way in a merge. This guard fails
// the build if the adapter stops registering any phone route.
const adapter = readFileSync(new URL('../../../../src/channels/http/http-adapter.ts', import.meta.url), 'utf8');

describe('HttpAdapter phone routes', () => {
  it.each(['phoneInboxRoutes', 'phoneMessageRoutes', 'phoneBooksRoutes', 'phoneBriefRoutes', 'phoneTriageRoutes', 'phoneInboxReadRoutes'])(
    'imports and registers %s',
    (name) => {
      expect(adapter, `${name} import`).toMatch(new RegExp(`import \\{ ${name} \\} from '\\./routes/`));
      expect(adapter, `${name} registration`).toMatch(new RegExp(`this\\.app\\.register\\(${name},`));
    },
  );
});
