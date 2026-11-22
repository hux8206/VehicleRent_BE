-- AlterTable stores
ALTER TABLE `stores` ADD COLUMN `reputationScore` INT NOT NULL DEFAULT 100;

-- AlterTable bookings
ALTER TABLE `bookings`
  ADD COLUMN `cancelType` INT NULL DEFAULT 0,
  ADD COLUMN `compensationAmount` DECIMAL(12, 2) NULL DEFAULT 0.00,
  ADD COLUMN `isForceMajeure` BOOLEAN NULL DEFAULT false,
  ADD COLUMN `forceMajeureProof` TEXT NULL,
  ADD COLUMN `disputeStatus` INT NULL DEFAULT 0,
  ADD COLUMN `disputeReason` VARCHAR(500) NULL,
  ADD COLUMN `disputeCreatedAt` DATETIME(3) NULL,
  ADD COLUMN `idCardFront` VARCHAR(500) NULL,
  ADD COLUMN `idCardBack` VARCHAR(500) NULL,
  ADD COLUMN `idCardCapturedAt` DATETIME(3) NULL,
  ADD COLUMN `idCardDeletedAt` DATETIME(3) NULL;
