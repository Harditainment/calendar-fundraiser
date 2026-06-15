/*
  Warnings:

  - You are about to drop the `DateClaim` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "DateClaim" DROP CONSTRAINT "DateClaim_userId_fkey";

-- DropTable
DROP TABLE "DateClaim";

-- CreateTable
CREATE TABLE "dateClaim" (
    "id" TEXT NOT NULL,
    "month" INTEGER NOT NULL,
    "day" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'CHARGED',
    "failureReason" TEXT,
    "chargedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "dateClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dateClaim_userId_idx" ON "dateClaim"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "dateClaim_userId_month_day_key" ON "dateClaim"("userId", "month", "day");

-- AddForeignKey
ALTER TABLE "dateClaim" ADD CONSTRAINT "dateClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
