import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { SiteSettingsService } from '../admin/site-settings.service';
import { EmailTemplateService } from '../cms/email-template.service';
import { SocialLinksService } from '../cms/social-links.service';

/**
 * What the public website and the apps read.
 *
 * Unauthenticated on purpose: every one of these values is already printed on
 * the landing page, so requiring a key to read them would protect nothing while
 * meaning the website needs a secret to render its own footer.
 *
 * Nothing private is served here. The admin's own view of the same row carries
 * who last changed it; this one does not.
 */
@Public()
@ApiTags('site')
@Controller('site')
export class SiteController {
  constructor(
    private readonly settings: SiteSettingsService,
    private readonly templates: EmailTemplateService,
    private readonly socials: SocialLinksService,
  ) {}

  /**
   * Contact details, store links, social handles and the maintenance switch.
   *
   * Cached for a minute at the edge, and served stale for an hour while it
   * revalidates: a landing page should not go blank because the API is briefly
   * unwell, and a phone number that is sixty seconds out of date has never hurt
   * anyone.
   */
  @Get()
  @Header('cache-control', 'public, max-age=60, stale-while-revalidate=3600')
  async settings_() {
    const [s, socials] = await Promise.all([this.settings.get(), this.socials.enabled()]);
    return {
      companyName: s.companyName,
      supportEmail: s.supportEmail,
      phone: s.phone,
      address: s.address,
      apps: {
        iosVersion: s.iosVersion,
        androidVersion: s.androidVersion,
        iosStoreUrl: s.iosStoreUrl,
        androidStoreUrl: s.androidStoreUrl,
      },
      maintenance: {
        active: s.maintenanceMode,
        message: s.maintenanceMessage,
      },
      /**
       * In the order an admin arranged them, each with its own icon.
       *
       * Replaces the old fixed { facebook, twitter, … } object: adding a
       * network used to be a schema change, and a footer that can only ever
       * show six named networks is a footer that needs a deploy to show a
       * seventh.
       */
      socials,
      logoUrl: s.hasLogo ? `/v1/site/logo?v=${s.logoVersion}` : null,
    };
  }

  /**
   * The picture on one email.
   *
   * Public because a mail client fetches it from outside our network, with no
   * session and no headers we control. There is nothing to protect: it is an
   * image an admin chose to send to every recipient of that email.
   *
   * Immutable per version, so a client that cached last month's banner gets the
   * new one the moment it is replaced.
   */
  @Get('email-image/:key')
  async emailImage(@Param('key') key: string, @Res() res: Response) {
    const { bytes, type, version } = await this.templates.image(key);
    res
      .type(type)
      .set('x-content-type-options', 'nosniff')
      .set('cache-control', 'public, max-age=31536000, immutable')
      // Mail clients proxy images through their own servers, which are a
      // different origin by definition. Helmet's default same-origin policy
      // would make Gmail's proxy fetch fail and the banner never appear.
      .set('cross-origin-resource-policy', 'cross-origin')
      .set('etag', `"${version}"`)
      .send(bytes);
  }

  /**
   * One social network's icon.
   *
   * Public and cross-origin for the same reason as the logo: it is fetched by
   * a mail client from outside our network, and it is an image an admin chose
   * to put in front of every recipient.
   */
  @Get('social/:id/icon')
  async socialIcon(@Param('id') id: string, @Res() res: Response) {
    const { bytes, type, version } = await this.socials.icon(id);
    res
      .type(type)
      .set('x-content-type-options', 'nosniff')
      .set('cache-control', 'public, max-age=31536000, immutable')
      .set('cross-origin-resource-policy', 'cross-origin')
      .set('etag', `"${version}"`)
      .send(bytes);
  }

  /** The brand mark. Immutable per version — a new logo is a new version. */
  @Get('logo')
  async logo(@Res() res: Response) {
    const { bytes, type, version } = await this.settings.logo();
    res
      .type(type)
      // An SVG is a document a browser will happily execute scripts inside.
      // Serving it as an attachment-safe download with no scripting allowed
      // keeps a brand asset from becoming a same-origin foothold.
      .set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .set('x-content-type-options', 'nosniff')
      .set('cache-control', 'public, max-age=31536000, immutable')
      /*
       * Overrides Helmet's global same-origin policy, for this route only.
       *
       * The logo is in the header of every email and in the website's footer,
       * both of which are a different origin to the API. Under the default
       * policy a browser refuses to render it and the brand mark is a broken
       * image in every inbox. There is nothing to protect here — this is a
       * public brand asset, served to anyone who asks, by design.
       */
      .set('cross-origin-resource-policy', 'cross-origin')
      .set('etag', `"${version}"`)
      .send(bytes);
  }
}
