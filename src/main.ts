import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { SEED_ARNE_API_SECRET } from './database/seed-constants';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Ledger Payment Engine API')
    .setDescription(
      `Core payment mechanics with double-entry bookkeeping.\n\n` +
        `Dev Bearer for seeded merchant Arne: \`${SEED_ARNE_API_SECRET}\` (Auth0 later).`,
    )
    .setVersion('0.1.0')  
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = Number(process.env.PORT ?? 3050);
  await app.listen(port);
}

void bootstrap();
