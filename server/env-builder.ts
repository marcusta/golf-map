// Builder mode accepts one upload far above the usual body limit: the edited
// square export of the cleaned photo (`PUT /api/ortho-patches/import/:courseId`,
// up to 400 MB). `@basics/core/server/config` reads `BODY_LIMIT` once, when it
// is first imported, so the limit is raised here: imported from main.ts before
// the config module, like env-paths.ts. Serve mode keeps the value its start
// script sets.
import { raiseBuilderBodyLimit } from './mode';

raiseBuilderBodyLimit();
