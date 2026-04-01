import { option, Option } from "scats";

export class MultiStepPayload<
  TUserPayload extends object = Record<string, unknown>,
> {
  constructor(
    readonly activeChildId: Option<number>,
    readonly workflowPayload: Record<string, any>,
    readonly userPayload: TUserPayload,
  ) {}

  copy(
    o: Partial<MultiStepPayload<TUserPayload>>,
  ): MultiStepPayload<TUserPayload> {
    return new MultiStepPayload<TUserPayload>(
      option(o.activeChildId).getOrElseValue(this.activeChildId),
      option(o.workflowPayload).getOrElseValue(this.workflowPayload),
      option(o.userPayload).getOrElseValue(this.userPayload),
    );
  }

  get toJson(): object {
    const res: Record<string, unknown> = {
      workflowPayload: this.workflowPayload,
      userPayload: this.userPayload,
    };
    this.activeChildId.foreach((id) => {
      res["activeChildId"] = id;
    });
    return res;
  }

  static fromJson<TUserPayload extends object>(
    j: unknown,
  ): MultiStepPayload<TUserPayload> {
    const o = option(j).map((x) => x as Record<string, unknown>);
    return new MultiStepPayload<TUserPayload>(
      o.flatMap((x) => option(x["activeChildId"])).map(Number),
      o
        .flatMap((x) => option(x["workflowPayload"]))
        .map((x) => x as Record<string, any>)
        .getOrElseValue({}),
      o
        .flatMap((x) => option(x["userPayload"] as TUserPayload))
        .getOrElseValue({} as TUserPayload),
    );
  }
}
