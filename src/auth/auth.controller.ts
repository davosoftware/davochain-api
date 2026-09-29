import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
} from './dto';
import { Public } from './public.decorator';
import { CurrentUser } from './current-user.decorator';
import type { JwtPayload } from './auth.service';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  private ctx(req: Request) {
    return { userAgent: req.headers['user-agent'], ip: req.ip };
  }

  @Public()
  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    return this.auth.register(dto, this.ctx(req));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, this.ctx(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, this.ctx(req));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  /**
   * Start a password reset.
   *
   * Unauthenticated by necessity — the people who need it are the ones who
   * cannot sign in. The response is identical whether or not the email matched
   * an account, because a different answer is a way to find out which addresses
   * are registered here.
   */
  @Public()
  @Post('reset/request')
  @HttpCode(200)
  async requestReset(@Body() dto: RequestPasswordResetDto) {
    // Swallowed on purpose: a rate-limit or SMTP error must not become the
    // signal that distinguishes a real account from a made-up one.
    await this.auth.requestPasswordReset(dto.email).catch(() => undefined);
    return {
      message: 'If that email belongs to an account, a six-digit code is on its way to it.',
    };
  }

  /**
   * Finish it.
   *
   * Returns no session: proving control of an inbox is weaker than knowing a
   * password, and handing back a signed-in session would make the six-digit
   * code as good as the password itself. They sign in with what they chose.
   */
  @Public()
  @Post('reset/confirm')
  @HttpCode(204)
  async confirmReset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.email, dto.code, dto.newPassword);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUser('sub') userId: string,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.auth.changePassword(userId, dto.currentPassword, dto.newPassword);
  }

  /** Who am I — the app calls this on launch to hydrate session state. */
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return { id: user.sub, email: user.email, kycTier: user.tier, kycStatus: user.kyc };
  }
}
