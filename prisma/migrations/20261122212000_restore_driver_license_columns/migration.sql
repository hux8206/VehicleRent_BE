-- AlterTable
ALTER TABLE `users`
  ADD COLUMN `driverLicense` VARCHAR(50) NULL,
  ADD COLUMN `driverLicenseBack` VARCHAR(500) NULL,
  ADD COLUMN `driverLicenseFront` VARCHAR(500) NULL;
