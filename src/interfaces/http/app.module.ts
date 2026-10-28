import { Injectable, Module, OnApplicationShutdown } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { EntityManager } from "@mikro-orm/postgresql";
import ormConfig from "../../infrastructure/persistence/mikro-orm.config";
import { MikroOrmWageringStore } from "../../infrastructure/persistence/repositories/mikro-orm-wagering.store";
import { WageringQueriesRepository } from "../../infrastructure/persistence/repositories/wagering-queries.repository";
import { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";
import { ProviderWageringController } from "./provider-wagering.controller";
import { HealthController } from "./health.controller";
import { MetricsController } from "./metrics.controller";
import { CorrelationIdMiddleware } from "./correlation-id.middleware";
import { MiddlewareConsumer, NestModule } from "@nestjs/common";
import { BackgroundWorkers } from "../../infrastructure/messaging/background-workers";

@Injectable()
class OrmShutdown implements OnApplicationShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({
  controllers: [
    WageringController,
    WalletsController,
    ProviderWageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    {
      provide: MikroORM,
      useFactory: () => MikroORM.init(ormConfig),
    },
    {
      provide: EntityManager,
      useFactory: (orm: MikroORM) => orm.em.fork(),
      inject: [MikroORM],
    },
    {
      provide: MikroOrmWageringStore,
      useFactory: (entityManager: EntityManager) =>
        new MikroOrmWageringStore(entityManager),
      inject: [EntityManager],
    },
    {
      provide: WageringQueriesRepository,
      useFactory: (entityManager: EntityManager) =>
        new WageringQueriesRepository(entityManager),
      inject: [EntityManager],
    },
    {
      provide: SubmitWagerTransaction,
      useFactory: (store: MikroOrmWageringStore) =>
        new SubmitWagerTransaction(store),
      inject: [MikroOrmWageringStore],
    },
    OrmShutdown,
    BackgroundWorkers,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");
  }
}
