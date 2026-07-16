const { PrismaClient, Prisma } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const term = "what is Section 504 of the Rehabilitation Act of 1973?";
  const query = Prisma.sql`plainto_tsquery(${"english"}::regconfig, ${term})`;
  const vector = Prisma.sql`(
    setweight(to_tsvector(${"english"}::regconfig, coalesce(d."title", ${""})), ${"A"}) ||
    setweight(to_tsvector(${"english"}::regconfig, coalesce(d."documentNumber", ${""})), ${"B"}) ||
    setweight(to_tsvector(${"english"}::regconfig, coalesce(d."description", ${""})), ${"B"}) ||
    coalesce(dc."searchVector", to_tsvector(${"english"}::regconfig, ${""}))
  )`;
  const rows = await prisma.$queryRaw(Prisma.sql`
    SELECT dc."id" AS "chunkId", dc."documentId", left(dc."content", 100) AS preview,
           ts_rank_cd(${vector}, ${query})::float8 AS "rank"
    FROM "policytracker"."DocumentChunk" dc
    JOIN "policytracker"."Document" d ON d."id" = dc."documentId"
    WHERE dc."versionId" = d."currentVersionId"
      AND d."status" = ${"published"}
      AND d."deletedAt" IS NULL
      AND ${vector} @@ ${query}
    ORDER BY ts_rank_cd(${vector}, ${query}) DESC
    LIMIT 5
  `);
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
