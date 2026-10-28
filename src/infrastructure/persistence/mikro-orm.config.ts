import { defineConfig } from "@mikro-orm/postgresql";
import { persistenceEntities } from "./entities/schemas";

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    "postgresql://wagering:wagering@localhost:5432/wagering",
  entities: persistenceEntities,
  migrations: {
    path: "./dist/infrastructure/persistence/migrations",
    pathTs: "./src/infrastructure/persistence/migrations",
    glob: "!(*.d).{js,ts}",
  },
});
