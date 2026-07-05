import { Module } from '@nestjs/common';
import { DeixisService } from './deixis.service';

@Module({
  providers: [DeixisService],
  exports: [DeixisService],
})
export class DeixisModule {}
