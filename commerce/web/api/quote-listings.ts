import type { IncomingMessage, ServerResponse } from 'node:http';

export const hostedMarketplace = 'https://ubc26-159-89-149-133.sslip.io';

type QuoteRequest = Pick<IncomingMessage, 'method' | 'headers'>;
type QuoteResponse = Pick<ServerResponse, 'statusCode' | 'setHeader' | 'end'>;

export function createQuoteListingsHandler(origin = hostedMarketplace) {
  const feed = new URL('/v1/jobs?limit=100', origin);

  return async function quoteListings(request: QuoteRequest, response: QuoteResponse) {
    response.setHeader('Content-Type', 'application/json');
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      const result = await fetch(feed, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!result.ok) throw new Error(`Quote feed returned ${result.status}`);
      const { jobs } = await result.json();
      if (!Array.isArray(jobs)) throw new Error('Invalid quote feed');
      response.end(JSON.stringify({ jobs }));
    } catch {
      response.statusCode = 502;
      response.end(JSON.stringify({ error: 'Quote listings unavailable' }));
    }
  };
}

export default createQuoteListingsHandler();
