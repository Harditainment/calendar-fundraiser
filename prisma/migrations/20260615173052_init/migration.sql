-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('PENDING', 'CHARGED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "stripeCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DateClaim" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'PENDING',
    "stripePaymentMethodId" TEXT,
    "failureReason" TEXT,
    "chargedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,

    CONSTRAINT "DateClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "DateClaim_date_key" ON "DateClaim"("date");

-- CreateIndex
CREATE INDEX "DateClaim_userId_idx" ON "DateClaim"("userId");

-- CreateIndex
CREATE INDEX "DateClaim_status_date_idx" ON "DateClaim"("status", "date");

-- AddForeignKey
ALTER TABLE "DateClaim" ADD CONSTRAINT "DateClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
