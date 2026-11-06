import {
  IssueDocumentReaderRequestSchema,
  type IssueDocumentReaderRequest,
  type IssueDocumentReaderResponse,
} from '@t3foundry/open-rocket-chat-api-contract';
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { zodPipe } from '../common/zod-validation.pipe';
import { SessionGuard } from '../session/session.guard';
import { TasraIssuerService } from './issuer.service';

/**
 * Credential issuance is not scoped to a Rocket.Chat server: the issuer signs
 * with the gateway's own key and never calls upstream. The route still needs a
 * session whose server connection resolves, because `SessionGuard` refuses a
 * cookie it cannot attach to any server — but nothing about the credential
 * depends on which server that is.
 */
@Controller('tasra/credentials')
@UseGuards(SessionGuard)
export class TasraIssuerController {
  constructor(private readonly issuer: TasraIssuerService) {}

  /**
   * `POST /api/v1/tasra/credentials/document-reader`
   *
   * Answers `201` because a credential is created, not merely fetched. The
   * body carries the compact SD-JWT VC the caller hands to a wallet.
   */
  @Post('document-reader')
  @HttpCode(HttpStatus.CREATED)
  async issue(
    @Body(zodPipe(IssueDocumentReaderRequestSchema)) body: IssueDocumentReaderRequest,
  ): Promise<IssueDocumentReaderResponse> {
    return this.issuer.issue(body);
  }
}
