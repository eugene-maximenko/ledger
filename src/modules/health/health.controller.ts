import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/metadata/public.metadata';
import { HealthResponseDto } from './dto/health-response.dto';

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  @ApiOperation({
    summary: 'Global health check',
    description: 'Returns basic API availability status.',
  })
  @ApiOkResponse({
    description: 'API is healthy.',
    type: HealthResponseDto,
  })
  @Get()
  getHealth(): HealthResponseDto {
    return { ok: true };
  }
}
