import { Router, type IRouter } from "express";
import healthRouter from "./health";
import customersRouter from "./customers";
import creditsRouter from "./credits";
import redemptionsRouter from "./redemptions";
import reportsRouter from "./reports";
import settingsRouter from "./settings";
import printavoRouter from "./printavo";
import rewardsRouter from "./rewards";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(customersRouter);
router.use(creditsRouter);
router.use(redemptionsRouter);
router.use(reportsRouter);
router.use(settingsRouter);
router.use(printavoRouter);
router.use(rewardsRouter);
router.use(storageRouter);

export default router;
