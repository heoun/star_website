import { serveListingsFeed } from './listings.js';
import { listingCollections } from '../site/shared/listing-collections.js';
import { listingCollectionMarkup, listingStateMarkup, listingImagePreloads } from '../site/shared/listing-cards.js';

export function isListingPage(pathname) {
  return /^\/(rental|buy|commercial)(\/|\/index\.html)?$/.test(pathname);
}

export async function serveListingPage(request, env, ctx) {
  const url = new URL(request.url);
  const pagePath = `/${url.pathname.split('/')[1]}/`;
  if (url.pathname !== pagePath) {
    url.pathname = pagePath;
    return Response.redirect(url.toString(), 308);
  }
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok || !asset.headers.get('Content-Type')?.includes('text/html')) return asset;
  let payload;
  try {
    payload = await (await serveListingsFeed(request, env, ctx)).json();
    // Never substitute bundled demonstration inventory for live listings.
    if (payload.source !== 'supabase') payload = null;
  } catch (error) {
    console.error('Listing page data unavailable', error);
  }
  const images = payload ? [...new Set(listingCollections[pagePath].flatMap(config => listingImagePreloads(payload, config, url.searchParams.get('q') || '')))].slice(0, 3) : [];
  const escapeAttribute = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  let rewriter = new HTMLRewriter().on('head', {element(element) {
    element.append(images.map((src, index) => `<link rel="preload" as="image" href="${escapeAttribute(src)}" fetchpriority="${index === 0 ? 'high' : 'auto'}">`).join(''), {html:true});
  }});
  for (const config of listingCollections[pagePath]) {
    const markup = payload
      ? listingCollectionMarkup(payload, config, url.searchParams.get('q') || '')
      : listingStateMarkup(config, 'error');
    rewriter = rewriter.on(config.gridSelector, {
      element(element) {
        element.setAttribute('data-rendered', 'true');
        element.setInnerContent(markup, {html:true});
      }
    });
  }
  const response = new Response(asset.body, asset);
  // The shared feed owns the 60-second cache; HTML must reflect query and publication state.
  response.headers.set('Cache-Control', 'no-store');
  response.headers.delete('ETag');
  response.headers.delete('Last-Modified');
  response.headers.delete('Content-Length');
  return rewriter.transform(response);
}
