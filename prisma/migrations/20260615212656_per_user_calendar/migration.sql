/*
  Warnings:

  - The values [PENDING] on the enum `ClaimStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `date` on the `DateClaim` table. All the data in the column will be lost.
  - You are about to drop the column `stripePaymentMethodId` on the `DateClaim` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,month,day]` on the table `DateClaim` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `day` to the `DateClaim` table without a default value. This is not possible if the table is not empty.
  - Added the required column `month` to the `DateClaim` table without a default value. This is not possible if the table is not empty.
  - Made the column `chargedAt` on table `DateClaim` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ClaimStatus_new" AS ENUM ('CHARGED', 'FAILED');
ALTER TABLE "DateClaim" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "DateClaim" ALTER COLUMN "status" TYPE "ClaimStatus_new" USING ("status"::text::"ClaimStatus_new");
ALTER TYPE "ClaimStatus" RENAME TO "ClaimStatus_old";
ALTER TYPE "ClaimStatus_new" RENAME TO "ClaimStatus";
DROP TYPE "ClaimStatus_old";
ALTER TABLE "DateClaim" ALTER COLUMN "status" SET DEFAULT 'CHARGED';
COMMIT;

-- DropIndex
DROP INDEX "DateClaim_date_key";

-- DropIndex
DROP INDEX "DateClaim_status_date_idx";

-- AlterTable
ALTER TABLE "DateClaim" DROP COLUMN "date",
DROP COLUMN "stripePaymentMethodId",
ADD COLUMN     "day" INTEGER NOT NULL,
ADD COLUMN     "month" INTEGER NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'CHARGED',
ALTER COLUMN "chargedAt" SET NOT NULL,
ALTER COLUMN "chargedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "DateClaim_userId_month_day_key" ON "DateClaim"("userId", "month", "day");
