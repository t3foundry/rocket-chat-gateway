import { Controller, Get, Header, HttpCode, HttpStatus } from '@nestjs/common';

import { TasraStatusListService } from './status-list.service';

/**
 * Public endpoint — no session guard. A status list is fetched by the network's
 * verifiers, which hold no gateway session, and it reveals nothing: it is a
 * bitstring with no holder in it.
 */
@Controller('tasra/status')
export class TasraStatusListController {
  constructor(private readonly statusList: TasraStatusListService) {}

  /**
   * `GET /api/v1/tasra/status/document-reader`
   *
   * The signed revocation list for `DocumentReader` credentials. `TASRA_STATUS_LIST_URL`
   * must be the address verifiers reach this route at.
   */
  @Get('document-reader')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'application/jwt')
  @Header('Cache-Control', 'no-store')
  read(): string {
    return this.statusList.token();
  }
}
