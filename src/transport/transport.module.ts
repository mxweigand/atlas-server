import { Module } from '@nestjs/common';
import { TransportGateway } from './transport.gateway';

@Module({
  providers: [TransportGateway],
  exports: [TransportGateway],
})
export class TransportModule {}
