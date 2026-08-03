-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "followUpsSent" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastFollowUpAt" TIMESTAMP(3),
ADD COLUMN     "readyEmailSentAt" TIMESTAMP(3),
ADD COLUMN     "unlockedEmailSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Report_status_paidAt_followUpsSent_idx" ON "Report"("status", "paidAt", "followUpsSent");
