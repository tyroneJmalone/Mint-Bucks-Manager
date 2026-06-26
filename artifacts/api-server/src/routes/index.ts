import { Router, type IRouter } from "express";
import healthRouter from "./health";
import customersRouter from "./customers";
import creditsRouter from "./credits";
import redemptionsRouter from "./redemptions";
import reportsRouter from "./reports";

const router: IRouter = Router();

router.use(healthRouter);
router.use(customersRouter);
router.use(creditsRouter);
router.use(redemptionsRouter);
router.use(reportsRouter);

export default router;
