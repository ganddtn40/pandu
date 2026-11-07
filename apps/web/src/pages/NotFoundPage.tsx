import { Link } from 'react-router-dom';

import { usePageTitle } from '../lib/hooks';

export function NotFoundPage() {
  usePageTitle('Not found · Cockpit');

  return (
    <div className="page page-not-found">
      <p className="eyebrow">
        <span className="eyebrow-line" aria-hidden="true" />
        Off course
      </p>
      <h1>
        404
        <span className="title-dot" aria-hidden="true">
          .
        </span>
      </h1>
      <p className="page-lede">
        There is no flight at this address. The recorder keeps a linear log, so head back to the
        archive.
      </p>
      <Link className="button" to="/sessions">
        Open flight log
      </Link>
    </div>
  );
}
