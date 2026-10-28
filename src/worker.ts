import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./interfaces/http/app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

void bootstrap();
