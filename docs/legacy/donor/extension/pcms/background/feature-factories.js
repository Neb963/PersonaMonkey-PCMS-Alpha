// Accepted P014–P019 feature modules, loaded only by the background Core host.
import { createAccountsService } from "/pcms-modules/p014/accounts.js";
import { createDeployerService } from "/pcms-modules/p015/deployer.js";
import { createDeployerRepositoryService } from "/pcms-modules/p015/repository-service.js";
import { createExplorerService } from "/pcms-modules/p016/explorer.js";
import { createRefresherService } from "/pcms-modules/p017/refresher.js";
import { createStatisticsService } from "/pcms-modules/p018/statistics.js";
import { createProvisioningService } from "/pcms-modules/p019/provisioning.js";

export const PCMS_BACKGROUND_FEATURE_FACTORIES=Object.freeze({
  accounts:createAccountsService,
  deployer:createDeployerService,
  repository:createDeployerRepositoryService,
  explorer:createExplorerService,
  refresher:createRefresherService,
  statistics:createStatisticsService,
  provisioning:createProvisioningService
});
