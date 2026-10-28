import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./interfaces/http/app.module";
import { PersistenceExceptionFilter } from "./interfaces/http/persistence-exception.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new PersistenceExceptionFilter(app.getHttpAdapter()));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0");
}

void bootstrap();
