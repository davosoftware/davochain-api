import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { CmsService } from './cms.service';

/**
 * What the website and the apps read.
 *
 * Unauthenticated, like `/v1/site`: a privacy policy is published to the world
 * by definition, and requiring a key to read one would mean the marketing site
 * needs a secret to render its own footer.
 *
 * Only published rows are served. A draft is not reachable from here at any
 * URL, so "unpublish" is a real control rather than a hidden link.
 */
@Public()
@ApiTags('content')
@Controller('content')
export class ContentController {
  constructor(private readonly cms: CmsService) {}

  /** Every published page — enough for a footer menu, without the bodies. */
  @Get('pages')
  @Header('cache-control', 'public, max-age=300, stale-while-revalidate=86400')
  pages() {
    return this.cms.publicPages();
  }

  /**
   * One page, as HTML, plain text and the Markdown source.
   *
   * Cached longer than `/v1/site` because legal copy changes far less often
   * than a phone number, and served stale for a day so an API hiccup cannot
   * take the Terms page down.
   */
  @Get('pages/:slug')
  @Header('cache-control', 'public, max-age=300, stale-while-revalidate=86400')
  page(@Param('slug') slug: string) {
    return this.cms.publicPage(slug);
  }

  /** Website only. Grouped by category, in the order the admin arranged them. */
  @Get('faqs')
  @Header('cache-control', 'public, max-age=300, stale-while-revalidate=86400')
  faqs() {
    return this.cms.publicFaqs();
  }
}
